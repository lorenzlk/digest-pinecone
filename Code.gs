// Google Apps Script to ingest "Mula Daily Digest -" emails hourly

const EMBEDDING_MODEL_ENDPOINT = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL_NAME     = 'text-embedding-ada-002';
const PROP_LAST_RUN            = 'lastSuccessfulRunTimestamp_v2';
const PROP_THREAD_HASHES       = 'threadHashes_v2';

let mappingsCache = null;
let internalDomains = [];

/**
 * Determines if the thread data represents a daily digest email
 * @param {Object} data - The extracted thread data object
 * @returns {boolean} True if this is a daily digest email
 */
function isDailyDigest(data) {
  if (!data || !data.participantEmails || !data.subject) {
    Logger.log('isDailyDigest: Invalid data object provided');
    return false;
  }
  
  return data.participantEmails.includes('logan.lorenz@offlinestudio.com')
      && data.subject.startsWith('Mula Daily Digest -');
}

/**
 * Main function to process Mula Daily Digest emails
 */
function processMulaDigest() {
  const props = PropertiesService.getScriptProperties();
  const OPENAI_KEY = props.getProperty('OPENAI_API_KEY_PROP');
  const PINECONE_KEY = props.getProperty('PINECONE_API_KEY_PROP');
  let indexHost = props.getProperty('PINECONE_INDEX_HOST_PROP');
  const env = props.getProperty('PINECONE_ENVIRONMENT_PROP');
  const idxName = props.getProperty('PINECONE_INDEX_NAME_PROP');
  const sheetId = props.getProperty('SPREADSHEET_ID_PROP');
  const mapSheet = props.getProperty('MAPPING_SHEET_NAME_PROP');
  const domains = props.getProperty('OUR_EMAIL_DOMAINS_PROP') || '';

  // Validate required properties
  if (!OPENAI_KEY || !PINECONE_KEY || !env || !idxName) {
    Logger.log('Missing required API keys or configuration');
    throw new Error('Missing required configuration properties');
  }

  // Load mappings and domains
  mappingsCache = loadPublisherMappings(sheetId, mapSheet);
  internalDomains = domains.split(',').map(d => d.trim().toLowerCase()).filter(d => d);

  // Determine last run timestamp
  const lastRun = parseInt(props.getProperty(PROP_LAST_RUN) || '0', 10);
  const since = new Date(lastRun * 1000);
  
  // Format date for Gmail search (YYYY/MM/DD)
  const year = since.getFullYear();
  const month = String(since.getMonth() + 1).padStart(2, '0');
  const day = String(since.getDate()).padStart(2, '0');
  const dateStr = `${year}/${month}/${day}`;
  
  const query = `subject:"Mula Daily Digest -" after:${dateStr}`;
  Logger.log(`Searching Gmail with query: ${query}`);
  
  const threads = GmailApp.search(query);
  Logger.log(`Found ${threads.length} threads to process`);

  // Discover Pinecone host if needed
  if (!indexHost) {
    indexHost = getPineconeIndexHost(idxName, env, PINECONE_KEY);
    if (indexHost) {
      props.setProperty('PINECONE_INDEX_HOST_PROP', indexHost);
    }
  }

  // Load existing thread hashes
  let hashes = {};
  try {
    const hashStr = props.getProperty(PROP_THREAD_HASHES);
    if (hashStr) {
      hashes = JSON.parse(hashStr);
    }
  } catch (e) {
    Logger.log(`Error parsing thread hashes: ${e.message}`);
    hashes = {};
  }

  let processedCount = 0;
  let errorCount = 0;

  for (const thread of threads) {
    try {
      const threadId = thread.getId();
      const messages = thread.getMessages();
      const data = extractThreadData(messages, threadId);
      
      // Debug log to check data structure
      Logger.log(`Thread ${threadId}: subject="${data.subject}", participantEmails=${data.participantEmails ? data.participantEmails.length : 'undefined'} emails`);

      // Check for label-based publisher override
      const labels = thread.getLabels().map(label => label.getName());
      for (const label of labels) {
        const labelKey = label.toLowerCase();
        if (mappingsCache[labelKey]) {
          data.pubId = mappingsCache[labelKey];
          break;
        }
      }
      data.gmailLabels = labels;

      // Calculate content hash for duplicate detection
      const contentHash = calculateHash(data.fullText);
      if (hashes[threadId] === contentHash) {
        Logger.log(`Skipping thread ${threadId} - no changes detected`);
        continue;
      }

      // Generate embedding
      const embedding = getEmbedding(data.fullText, OPENAI_KEY);
      if (!embedding) {
        Logger.log(`Failed to generate embedding for thread ${threadId}`);
        errorCount++;
        continue;
      }

      // Prepare payload for Pinecone
      const payload = [{
        id: threadId,
        values: embedding,
        metadata: {
          pubId: data.pubId,
          subject: data.subject,
          lastMessageDate: data.lastMessageDate,
          participantEmails: data.participantEmails.join(', '),
          threadHash: contentHash,
          dailyDigest: isDailyDigest(data),
          gmailLabels: labels.join(', '),
          fullText: data.fullText.substring(0, 40000) // Limit metadata size
        }
      }];

      // Upsert to Pinecone
      const success = upsertToPinecone(indexHost, PINECONE_KEY, payload);
      if (success) {
        hashes[threadId] = contentHash;
        processedCount++;
        Logger.log(`Successfully processed thread: ${data.subject}`);
      } else {
        Logger.log(`Failed to upsert thread ${threadId} to Pinecone`);
        errorCount++;
      }
    } catch (error) {
      Logger.log(`Error processing thread: ${error.message}`);
      errorCount++;
    }
  }

  // Save updated state
  try {
    props.setProperty(PROP_THREAD_HASHES, JSON.stringify(hashes));
    props.setProperty(PROP_LAST_RUN, String(Math.floor(Date.now() / 1000)));
  } catch (error) {
    Logger.log(`Error saving state: ${error.message}`);
  }

  Logger.log(`Processing complete. Processed: ${processedCount}, Errors: ${errorCount}, Total threads: ${threads.length}`);
}

/**
 * Loads publisher mappings from a Google Sheet
 * @param {string} sheetId - The Google Sheet ID
 * @param {string} mapSheet - The sheet name containing mappings
 * @returns {Object} Mapping of lowercase labels to publisher IDs
 */
function loadPublisherMappings(sheetId, mapSheet) {
  const mappings = {};
  
  if (!sheetId || !mapSheet) {
    Logger.log('Sheet ID or mapping sheet name not provided, using empty mappings');
    return mappings;
  }

  try {
    const spreadsheet = SpreadsheetApp.openById(sheetId);
    const sheet = spreadsheet.getSheetByName(mapSheet);
    
    if (!sheet) {
      Logger.log(`Mapping sheet '${mapSheet}' not found in spreadsheet`);
      return mappings;
    }

    const data = sheet.getDataRange().getValues();
    
    // Skip header row, process data rows
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[0] && row[1]) {
        const label = row[0].toString().toLowerCase().trim();
        const pubId = row[1].toString().trim();
        if (label && pubId) {
          mappings[label] = pubId;
        }
      }
    }
    
    Logger.log(`Loaded ${Object.keys(mappings).length} publisher mappings`);
  } catch (error) {
    Logger.log(`Error loading publisher mappings: ${error.message}`);
  }

  return mappings;
}

/**
 * Discovers the Pinecone index host URL
 * @param {string} indexName - The Pinecone index name
 * @param {string} environment - The Pinecone environment
 * @param {string} apiKey - The Pinecone API key
 * @returns {string} The index host URL
 */
function getPineconeIndexHost(indexName, environment, apiKey) {
  try {
    const url = `https://controller.${environment}.pinecone.io/databases/${indexName}`;
    const options = {
      method: 'GET',
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json'
      },
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    
    if (responseCode === 200) {
      const data = JSON.parse(response.getContentText());
      if (data.status && data.status.host) {
        const host = `https://${data.status.host}`;
        Logger.log(`Discovered Pinecone index host: ${host}`);
        return host;
      }
    }
    
    Logger.log(`Failed to discover index host. Response: ${response.getContentText()}`);
    throw new Error(`Failed to get Pinecone index host: ${responseCode}`);
  } catch (error) {
    Logger.log(`Error discovering Pinecone index host: ${error.message}`);
    throw error;
  }
}

/**
 * Extracts relevant data from Gmail messages within a thread
 * @param {GoogleAppsScript.Gmail.GmailMessage[]} messages - Array of Gmail messages
 * @param {string} threadId - The Gmail thread ID
 * @returns {Object} Extracted thread data
 */
function extractThreadData(messages, threadId) {
  // Initialize with defaults to ensure all properties exist
  let fullText = '';
  const participantEmails = new Set();
  let subject = '';
  let lastMessageDate = 0;
  let pubId = 'unknown';

  try {
    if (messages && messages.length > 0) {
      // Get subject from first message
      subject = messages[0].getSubject() || '';
      
      // Get date from last message
      const lastMsg = messages[messages.length - 1];
      lastMessageDate = Math.floor(lastMsg.getDate().getTime() / 1000);

      // Process each message
      messages.forEach((message, index) => {
        try {
          // Add message body to full text
          const body = message.getPlainBody() || '';
          if (body) {
            fullText += body + '\n\n';
          }

          // Extract email addresses from headers
          const emailFields = ['From', 'To', 'Cc', 'Bcc'];
          emailFields.forEach(field => {
            try {
              const header = message.getHeader(field);
              if (header) {
                extractEmailsFromHeader(header, participantEmails);
              }
            } catch (headerError) {
              Logger.log(`Error extracting ${field} header from message ${index} in thread ${threadId}: ${headerError.message}`);
            }
          });

          // Also get sender and recipient from message methods
          try {
            const sender = message.getFrom();
            if (sender) {
              extractEmailsFromHeader(sender, participantEmails);
            }
          } catch (senderError) {
            Logger.log(`Error extracting sender from message ${index} in thread ${threadId}: ${senderError.message}`);
          }
          
          try {
            const recipient = message.getTo();
            if (recipient) {
              extractEmailsFromHeader(recipient, participantEmails);
            }
          } catch (recipientError) {
            Logger.log(`Error extracting recipient from message ${index} in thread ${threadId}: ${recipientError.message}`);
          }
        } catch (msgError) {
          Logger.log(`Error processing message ${index} in thread ${threadId}: ${msgError.message}`);
        }
      });
    }
  } catch (error) {
    Logger.log(`Error in extractThreadData for thread ${threadId}: ${error.message}`);
  }

  // Always return a complete object structure
  const result = {
    subject: subject || '',
    fullText: fullText.trim(),
    lastMessageDate: lastMessageDate,
    participantEmails: Array.from(participantEmails),
    pubId: pubId
  };
  
  Logger.log(`Extracted data for thread ${threadId}: ${result.participantEmails.length} emails, subject: "${result.subject.substring(0, 50)}..."`);
  return result;
}

/**
 * Extracts email addresses from a header string
 * @param {string} header - The email header string
 * @param {Set} emailSet - Set to add extracted emails to
 */
function extractEmailsFromHeader(header, emailSet) {
  if (!header) return;

  // Match emails in angle brackets: Name <email@domain.com>
  const bracketMatches = header.match(/<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/g);
  if (bracketMatches) {
    bracketMatches.forEach(match => {
      const email = match.replace(/<|>/g, '').toLowerCase();
      if (email) emailSet.add(email);
    });
  }

  // Match standalone email addresses
  const emailMatches = header.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g);
  if (emailMatches) {
    emailMatches.forEach(email => {
      if (email) emailSet.add(email.toLowerCase());
    });
  }
}

/**
 * Calculates a simple hash of the given data
 * @param {string} data - The string data to hash
 * @returns {string} The hash as a string
 */
function calculateHash(data) {
  if (!data) return '0';
  
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString();
}

/**
 * Gets an embedding from OpenAI API
 * @param {string} text - The text to embed
 * @param {string} apiKey - OpenAI API key
 * @returns {number[]|null} The embedding vector or null on error
 */
function getEmbedding(text, apiKey) {
  if (!text || !apiKey) {
    Logger.log('Missing text or API key for embedding');
    return null;
  }

  // Truncate text if too long (OpenAI has token limits)
  const maxLength = 8000; // Conservative limit
  const truncatedText = text.length > maxLength ? text.substring(0, maxLength) : text;

  try {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      payload: JSON.stringify({
        input: truncatedText,
        model: EMBEDDING_MODEL_NAME
      }),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(EMBEDDING_MODEL_ENDPOINT, options);
    const responseCode = response.getResponseCode();
    
    if (responseCode === 200) {
      const data = JSON.parse(response.getContentText());
      if (data.data && data.data.length > 0 && data.data[0].embedding) {
        return data.data[0].embedding;
      } else {
        Logger.log('Invalid embedding response structure');
        return null;
      }
    } else {
      Logger.log(`OpenAI API error ${responseCode}: ${response.getContentText()}`);
      return null;
    }
  } catch (error) {
    Logger.log(`Error getting embedding: ${error.message}`);
    return null;
  }
}

/**
 * Upserts vectors to Pinecone
 * @param {string} indexHost - The Pinecone index host URL
 * @param {string} apiKey - Pinecone API key
 * @param {Array} payload - Array of vector objects to upsert
 * @returns {boolean} True if successful, false otherwise
 */
function upsertToPinecone(indexHost, apiKey, payload) {
  if (!indexHost || !apiKey || !payload || payload.length === 0) {
    Logger.log('Missing required parameters for Pinecone upsert');
    return false;
  }

  try {
    const url = `${indexHost}/vectors/upsert`;
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': apiKey
      },
      payload: JSON.stringify({
        vectors: payload
      }),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    
    if (responseCode === 200) {
      Logger.log('Successfully upserted vectors to Pinecone');
      return true;
    } else {
      Logger.log(`Pinecone upsert failed ${responseCode}: ${response.getContentText()}`);
      return false;
    }
  } catch (error) {
    Logger.log(`Error upserting to Pinecone: ${error.message}`);
    return false;
  }
}

/**
 * Test function to validate configuration
 */
function testConfiguration() {
  const props = PropertiesService.getScriptProperties();
  const requiredProps = [
    'OPENAI_API_KEY_PROP',
    'PINECONE_API_KEY_PROP',
    'PINECONE_ENVIRONMENT_PROP', 
    'PINECONE_INDEX_NAME_PROP'
  ];

  const missing = [];
  requiredProps.forEach(prop => {
    if (!props.getProperty(prop)) {
      missing.push(prop);
    }
  });

  if (missing.length > 0) {
    Logger.log(`Missing required properties: ${missing.join(', ')}`);
    return false;
  }

  Logger.log('All required configuration properties are set');
  return true;
}

/**
 * Test function to process a single email thread manually
 * Use this to debug issues with a specific thread
 */
function testSingleThread() {
  try {
    // Search for the most recent daily digest
    const query = 'subject:"Mula Daily Digest -"';
    const threads = GmailApp.search(query, 0, 1);
    
    if (threads.length === 0) {
      Logger.log('No Mula Daily Digest threads found');
      return;
    }
    
    const thread = threads[0];
    const threadId = thread.getId();
    const messages = thread.getMessages();
    
    Logger.log(`Testing thread: ${threadId}`);
    Logger.log(`Thread has ${messages.length} messages`);
    
    // Test data extraction
    const data = extractThreadData(messages, threadId);
    Logger.log(`Extracted data:`);
    Logger.log(`- Subject: ${data.subject}`);
    Logger.log(`- Participant emails: ${data.participantEmails.join(', ')}`);
    Logger.log(`- Full text length: ${data.fullText.length}`);
    Logger.log(`- Last message date: ${new Date(data.lastMessageDate * 1000)}`);
    
    // Test daily digest detection
    const isDigest = isDailyDigest(data);
    Logger.log(`- Is daily digest: ${isDigest}`);
    
    // Test hash calculation  
    const hash = calculateHash(data.fullText);
    Logger.log(`- Content hash: ${hash}`);
    
    Logger.log('Single thread test completed successfully');
  } catch (error) {
    Logger.log(`Error in testSingleThread: ${error.message}`);
    Logger.log(`Stack trace: ${error.stack}`);
  }
} 