# Setup Guide for Mula Daily Digest Email Ingestion

## Prerequisites

1. **Google Account** with Gmail access
2. **OpenAI API Key** - Get from [OpenAI Platform](https://platform.openai.com/api-keys)
3. **Pinecone Account** - Sign up at [Pinecone](https://www.pinecone.io/)
4. **Google Sheets** (optional) - For publisher mappings

## Step 1: Create Google Apps Script Project

1. Go to [Google Apps Script](https://script.google.com/)
2. Click "New Project"
3. Replace the default code with the contents of `Code.gs`
4. Copy the `appsscript.json` manifest file content
5. Save the project with a meaningful name like "Mula Digest Ingestion"

## Step 2: Set Script Properties

In your Google Apps Script project:

1. Click on "Project Settings" (gear icon)
2. Scroll down to "Script Properties"
3. Add the following properties:

### Required Properties

| Property Name | Description | Example |
|---------------|-------------|---------|
| `OPENAI_API_KEY_PROP` | Your OpenAI API key | `sk-...` |
| `PINECONE_API_KEY_PROP` | Your Pinecone API key | `xxx-xxx-xxx` |
| `PINECONE_ENVIRONMENT_PROP` | Your Pinecone environment | `us-east1-gcp` |
| `PINECONE_INDEX_NAME_PROP` | Your Pinecone index name | `mula-digest` |

### Optional Properties

| Property Name | Description | Example |
|---------------|-------------|---------|
| `PINECONE_INDEX_HOST_PROP` | Pinecone index host (auto-discovered if empty) | `https://xxx.pinecone.io` |
| `SPREADSHEET_ID_PROP` | Google Sheets ID for publisher mappings | `1abc...xyz` |
| `MAPPING_SHEET_NAME_PROP` | Sheet name for mappings | `Publishers` |
| `OUR_EMAIL_DOMAINS_PROP` | Comma-separated internal domains | `company.com,internal.com` |

## Step 3: Set Up Pinecone Index

1. Log into your Pinecone account
2. Create a new index with these settings:
   - **Name**: `mula-digest` (or whatever you set in properties)
   - **Dimensions**: `1536` (for OpenAI text-embedding-ada-002)
   - **Metric**: `cosine`
   - **Pod Type**: `p1.x1` (starter tier)

## Step 4: Create Publisher Mapping Sheet (Optional)

If you want to map Gmail labels to publisher IDs:

1. Create a new Google Sheet
2. Set up columns like this:

| Label | Publisher ID |
|-------|-------------|
| tech-news | pub_tech_001 |
| finance | pub_finance_002 |
| sports | pub_sports_003 |

3. Copy the Google Sheets ID from the URL
4. Add it to `SPREADSHEET_ID_PROP` in script properties
5. Set the sheet name in `MAPPING_SHEET_NAME_PROP`

## Step 5: Test the Setup

1. In Google Apps Script, run the `testConfiguration()` function first
2. Check the execution log for any missing properties
3. Run the `testSingleThread()` function to test data extraction
4. Check logs to verify everything is working

## Step 6: Set Up Automation

1. In Google Apps Script, click "Triggers" (clock icon)
2. Click "+ Add Trigger"
3. Configure:
   - **Function**: `processMulaDigest`
   - **Event source**: `Time-driven`
   - **Type**: `Hour timer`
   - **Hour interval**: `Every hour`
4. Save the trigger

## Step 7: Grant Permissions

When you first run the script, you'll need to:

1. Click "Review permissions"
2. Choose your Google account
3. Click "Advanced" if you see a warning
4. Click "Go to [Your Project Name] (unsafe)"
5. Click "Allow"

The script needs these permissions:
- Read Gmail messages
- Read Google Sheets (if using mappings)
- Make external HTTP requests (for OpenAI and Pinecone APIs)

## Troubleshooting

### Common Issues

1. **"Cannot read properties of undefined"**
   - Check that all required script properties are set
   - Verify your Gmail has "Mula Daily Digest" emails

2. **OpenAI API errors**
   - Verify your API key is correct
   - Check you have sufficient OpenAI credits

3. **Pinecone connection errors**
   - Verify your API key and environment
   - Check that your index exists and has the right dimensions

4. **No emails found**
   - Verify the subject line filter matches your emails exactly
   - Check the date range in Gmail search

### Debug Functions

- Run `testConfiguration()` to check all properties are set
- Run `testSingleThread()` to test with one email thread
- Check the execution logs for detailed error messages

### Support

If you encounter issues:

1. Check the execution logs in Google Apps Script
2. Verify all API keys and configurations
3. Test individual functions to isolate problems
4. Make sure your Pinecone index dimensions match OpenAI embeddings (1536)

## Security Notes

- Never commit API keys to version control
- Use Google Apps Script's built-in properties service for secrets
- Regularly rotate API keys for security
- Monitor usage to detect any unusual activity 