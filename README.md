# Mula Daily Digest Email Ingestion

A Google Apps Script project that automatically ingests "Mula Daily Digest" emails into Pinecone vector database with OpenAI embeddings.

## Features

- Hourly processing of Mula Daily Digest emails
- Email content embedding using OpenAI's text-embedding-ada-002 model
- Vector storage in Pinecone database
- Gmail label-based publisher mapping
- Duplicate detection using content hashing
- Configurable email domain filtering

## Setup

### Required Google Apps Script Properties

Set the following script properties in your Google Apps Script project:

```
OPENAI_API_KEY_PROP - Your OpenAI API key
PINECONE_API_KEY_PROP - Your Pinecone API key
PINECONE_INDEX_HOST_PROP - Your Pinecone index host (optional, will be auto-discovered)
PINECONE_ENVIRONMENT_PROP - Your Pinecone environment
PINECONE_INDEX_NAME_PROP - Your Pinecone index name
SPREADSHEET_ID_PROP - Google Sheets ID for publisher mappings
MAPPING_SHEET_NAME_PROP - Sheet name containing label->publisher mappings
OUR_EMAIL_DOMAINS_PROP - Comma-separated list of internal email domains
```

### Publisher Mapping Sheet Format

Create a Google Sheet with the label-to-publisher mappings:

| Label | Publisher ID |
|-------|-------------|
| tech-news | pub_001 |
| finance | pub_002 |

## Usage

1. Deploy the script in Google Apps Script
2. Set up the required script properties
3. Create a time-driven trigger to run `processMulaDigest()` hourly
4. The script will automatically process new digest emails and store them in Pinecone

## File Structure

- `Code.gs` - Main Google Apps Script code
- `README.md` - This documentation
- `appsscript.json` - Apps Script manifest file 