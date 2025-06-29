import type { Express } from "express";
import { storage } from "../storage";
import { pythonBridge } from "./python-bridge";
import { log } from "../vite";

// Facebook API response interfaces
interface FacebookSendResponse {
  recipient_id: string;
  message_id?: string;
  error?: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id: string;
  };
}

/**
 * Sets up the webhook routes for Facebook Messenger
 * @param app Express application
 */
export function setupFacebookWebhook(app: Express) {
  // Facebook Webhook Verification
  app.get('/webhook', (req, res) => {
    pythonBridge.handleWebhookVerification(req, res);
  });

  // Facebook Webhook Events
  app.post('/webhook', async (req, res) => {
    await pythonBridge.handleWebhookEvent(req, res);
  });

  // Initialize the Python bridge for chatbot functionality
  initializePythonBridge();
}

/**
 * Initializes the Python bridge for chatbot functionality
 */
async function initializePythonBridge() {
  try {
    const result = await pythonBridge.initialize();
    if (result) {
      log('Python bridge initialized successfully', 'facebook');
    } else {
      log('Python bridge initialization failed, using Node.js fallback', 'facebook');
    }
  } catch (error) {
    log(`Error initializing Python bridge: ${error}`, 'facebook');
  }
}

/**
 * Sends a message to a user via the appropriate platform (Facebook Messenger or Instagram)
 * Implements both the Facebook Send API and Instagram Graph API depending on the page platform
 */
export async function sendFacebookMessage(recipientId: string, pageId: string, text: string) {
  try {
    const page = await storage.getPageByPageId(pageId);
    
    if (!page) {
      throw new Error(`Page with ID ${pageId} not found`);
    }
    
    // Get the access token - prioritize database over config
    let accessToken = page.accessToken;
    
    if (!accessToken) {
      throw new Error(`No access token found for page ID ${pageId}. Please reconnect this page through the OAuth flow to get a token with proper permissions.`);
    }
    
    log(`Using access token from database for page ${pageId}`, 'facebook');
    
    // Prepare the message data
    let messageData = {
      recipient: {
        id: recipientId
      },
      message: {
        text: text
      },
      messaging_type: "RESPONSE" // Standard for all API compliance
    };
    
    // Special handling for Majal page which has specific requirements
    if (pageId === '609967905535070') {
      log(`Using enhanced format for Majal page`, 'facebook');
    }
    
    // Use node-fetch for HTTP requests
    const fetch = (await import('node-fetch')).default;
    
    // DETERMINE WHICH API TO USE BASED ON PAGE PLATFORM AND RECIPIENT TYPE
    
    // Case 1: Direct Instagram Business Account
    if (page.platform === "Instagram") {
      // Use Instagram Graph API directly
      const apiUrl = `https://graph.instagram.com/v18.0/me/messages?access_token=${accessToken}`;
      log(`Using Instagram Graph API for direct Instagram business account ${pageId}`, 'instagram');
      
      const response = await fetch(
        apiUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(messageData)
        }
      );
      
      const responseData = await response.json() as FacebookSendResponse;
      
      if (response.ok) {
        log(`Instagram message sent successfully to ${recipientId}, message_id: ${responseData.message_id || 'unknown'}`, 'instagram');
        
        // Log the sending
        await storage.createActivity({
          type: 'conversation',
          description: `Instagram message sent to ${recipientId} via page ${pageId}`,
          metadata: { text, responseData: JSON.stringify(responseData) }
        });
        
        return true;
      } else {
        throw new Error(`Instagram API error: ${JSON.stringify(responseData)}`);
      }
    } 
    // Case 2: Instagram User via Facebook Page
    else if (page.platform === "Facebook" && 
             page.metadata && 
             page.metadata.instagramIds && 
             page.metadata.instagramIds.includes(recipientId)) {
      
      // Use Facebook Graph API with platform=instagram parameter
      const apiUrl = `https://graph.facebook.com/v20.0/me/messages?platform=instagram&access_token=${accessToken}`;
      log(`Using Facebook Graph API with platform=instagram parameter for Instagram user ${recipientId} via Facebook page ${pageId}`, 'facebook');
      
      const response = await fetch(
        apiUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(messageData)
        }
      );
      
      const responseData = await response.json() as FacebookSendResponse;
      
      if (response.ok) {
        log(`Instagram message (via Facebook page) sent successfully to ${recipientId}, message_id: ${responseData.message_id || 'unknown'}`, 'facebook');
        
        // Log the sending
        await storage.createActivity({
          type: 'conversation',
          description: `Instagram message (via Facebook) sent to ${recipientId} via page ${pageId}`,
          metadata: { text, responseData: JSON.stringify(responseData) }
        });
        
        return true;
      } else {
        throw new Error(`Facebook API error (Instagram via Facebook): ${JSON.stringify(responseData)}`);
      }
    }
    // Case 3: Regular Facebook Messenger
    else {
      // Use standard Facebook Graph API
      const apiUrl = `https://graph.facebook.com/v20.0/me/messages?access_token=${accessToken}`;
      log(`Using standard Facebook Graph API for recipient ${recipientId} via page ${pageId}`, 'facebook');
      
      // Add detailed logging for all Facebook pages
      log(`DETAIL: Facebook page ${pageId} - Sending to recipient ID: ${recipientId}`, 'facebook');
      log(`DETAIL: Facebook page ${pageId} - Access token preview: ${accessToken.substring(0, 20)}...`, 'facebook');
      log(`DETAIL: Facebook page ${pageId} - Message data: ${JSON.stringify(messageData)}`, 'facebook');
      
      const response = await fetch(
        apiUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(messageData)
        }
      );
      
      const responseData = await response.json() as FacebookSendResponse;
      
      if (response.ok) {
        log(`Facebook message sent successfully to ${recipientId}, message_id: ${responseData.message_id || 'unknown'}`, 'facebook');
        
        // Log the sending
        await storage.createActivity({
          type: 'conversation',
          description: `Facebook message sent to ${recipientId} via page ${pageId}`,
          metadata: { text, responseData: JSON.stringify(responseData) }
        });
        
        return true;
      } else {
        throw new Error(`Facebook API error: ${JSON.stringify(responseData)}`);
      }
    }
  } catch (error) {
    log(`Error sending message: ${error}`, 'facebook');
    throw error;
  }
}
