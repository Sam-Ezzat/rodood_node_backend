/**
 * Instagram Direct API integration
 * Handles sending messages directly to Instagram business accounts
 */

import { storage } from "../storage";
import { log } from "../vite";

interface InstagramSendResponse {
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
 * Sends a message directly to a user via Instagram DM
 * This uses the Instagram Graph API directly for Instagram business accounts
 */
export async function sendInstagramMessage(recipientId: string, pageId: string, text: string) {
  try {
    // Get the Instagram page from storage
    const page = await storage.getPageByPageId(pageId);
    
    if (!page) {
      throw new Error(`Instagram page with ID ${pageId} not found`);
    }
    
    // Verify this is an Instagram business account
    if (page.platform !== "Instagram") {
      throw new Error(`Page ${pageId} is not an Instagram business account`);
    }
    
    // Get the access token
    const accessToken = page.accessToken;
    
    if (!accessToken) {
      throw new Error(`No access token found for Instagram page ID ${pageId}`);
    }
    
    // Prepare the message data
    const messageData = {
      recipient: {
        id: recipientId
      },
      message: {
        text: text
      },
      messaging_type: "RESPONSE"
    };
    
    // Log the sending attempt
    log(`Sending direct Instagram message to ${recipientId} via Instagram page ${pageId}`, 'instagram');
    
    // Use node-fetch for HTTP requests
    const fetch = (await import('node-fetch')).default;
    
    // Use the Instagram Graph API endpoint
    const apiUrl = `https://graph.instagram.com/v18.0/me/messages?access_token=${accessToken}`;
    
    log(`Using Instagram Graph API URL: ${apiUrl}`, 'instagram');
    
    // Send the message
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
    
    const responseData = await response.json() as InstagramSendResponse;
    
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
  } catch (error) {
    log(`Error sending Instagram message: ${error}`, 'instagram');
    throw error;
  }
}