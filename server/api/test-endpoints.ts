/**
 * Test endpoints for debugging and verifying functionality 
 * These endpoints should NOT be exposed in production
 */
import express, { Request, Response } from 'express';
import { storage } from '../storage';
import { eq, and } from 'drizzle-orm';
import { conversations, messages, userStates, pages } from '@shared/schema';
import { db } from '../db';
import { log } from '../vite';
import { handleTestGreeting, handleCreateGreetingTest, handleCreateTestConversation } from './test-bridge';
import { pythonBridge } from './python-bridge';
import fetch from 'node-fetch';

const router = express.Router();

/**
 * Endpoint to test the checkGreetingMessage functionality
 * 
 * IMPORTANT: This endpoint is used to test the critical fix for greeting message detection.
 * The fix ensures we only check messages FROM THE BOT/PAGE for the greeting text, not messages from users.
 * This matches Facebook's actual behavior where ads trigger an initial greeting message from the page,
 * not from the user.
 * 
 * Test cases:
 * 1. Bot sends greeting message → has_greeting = true (correct)
 * 2. No greeting message → has_greeting = false (correct)
 * 3. Only user sends greeting → has_greeting = false (fixed behavior, was incorrectly true before)
 */
router.post('/check-greeting', handleTestGreeting);
router.post('/test-greeting', handleTestGreeting); // Alias for check-greeting for our tests

// Create test conversation for greeting message testing
router.post('/create-conversation', handleCreateGreetingTest);

// Create test conversation with specific messages for our test script
router.post('/create-test-conversation', handleCreateTestConversation);

// Endpoint to get all pages for testing
router.get('/pages', async (req: Request, res: Response) => {
  try {
    const allPages = await storage.getAllPages();
    log(`[TEST] Returning ${allPages.length} pages for testing`, 'test-endpoints');
    return res.json(allPages);
  } catch (error: any) {
    log(`[TEST] Error getting pages: ${error?.message || String(error)}`, 'test-endpoints');
    return res.status(500).json({ error: 'Failed to get pages' });
  }
});

// Endpoint to get a specific page by ID for testing
router.get('/page/:pageId', async (req: Request, res: Response) => {
  try {
    const { pageId } = req.params;
    
    if (!pageId) {
      return res.status(400).json({ error: 'Missing pageId parameter' });
    }
    
    const page = await storage.getPageByPageId(pageId);
    
    if (!page) {
      return res.status(404).json({ error: 'Page not found' });
    }
    
    log(`[TEST] Returning page data for pageId ${pageId}`, 'test-endpoints');
    return res.json(page);
  } catch (error: any) {
    log(`[TEST] Error getting page: ${error?.message || String(error)}`, 'test-endpoints');
    return res.status(500).json({ error: 'Failed to get page' });
  }
});

// Endpoint to create test data for greeting message testing
router.post('/create-greeting-test', async (req: Request, res: Response) => {
  try {
    const { page_id, with_greeting = true, user_greeting = false } = req.body;
    
    if (!page_id) {
      return res.status(400).json({ error: 'Missing page_id' });
    }
    
    // Get the greeting message for this page from the database
    const page = await storage.getPageByPageId(page_id);
    
    if (!page) {
      return res.status(404).json({ error: 'Page not found' });
    }
    
    // Get the greeting message from the page metadata
    const metadata = page.metadata as Record<string, any> | null;
    const greetingMessage = metadata?.greetingMessage || "";
    
    // Generate a unique test sender ID
    const senderId = `test_${with_greeting ? 'with' : 'without'}_greeting_${Date.now()}`;
    
    // Create a test conversation
    const [conversation] = await db
      .insert(conversations)
      .values({
        pageId: page_id,
        senderId: senderId,
        messagingType: 'RESPONSE',
        status: 'active'
      })
      .returning();
    
    // Add a message from the bot
    await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        sender: 'bot', // From the bot/page
        text: with_greeting 
          ? `Welcome! ${greetingMessage}` // With greeting
          : 'Welcome to our page!',        // Without greeting 
        responseTime: 0
      });
    
    // Add a user response, optionally with greeting in user message
    await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        sender: 'user', // From the user
        text: user_greeting 
          ? greetingMessage // Test case where user sends the greeting
          : 'Hello there!',
        responseTime: null
      });
    
    return res.json({ 
      success: true,
      sender_id: senderId,
      page_id: page_id,
      with_greeting,
      user_greeting,
      test_command: `curl -X POST http://localhost:5000/api/test/check-greeting -H "Content-Type: application/json" -d '{"sender_id": "${senderId}", "page_id": "${page_id}"}'`
    });
    
  } catch (error) {
    log(`Error in create-greeting-test endpoint: ${error}`, 'test-endpoints');
    return res.status(500).json({ error: 'Failed to create test data' });
  }
});

/**
 * Test endpoint to verify user state persistence to the database
 * This simulates a user interaction to test the save_user_state_to_db function
 */
router.post('/test-user-state', async (req: Request, res: Response) => {
  try {
    const { senderId = 'test_' + Date.now(), pageId = '420350114484751' } = req.body;
    
    // Create a sample user message
    const testMessage = req.body.message || 'Hello from test-user-state endpoint';
    
    log(`Testing user state persistence via /api/message with sender_id=${senderId}, page_id=${pageId}`, 'test-endpoints');
    
    // Call the Python endpoint to process the message
    const pythonUrl = 'http://localhost:5000/api/message';
    
    // Log the payload we're sending to ensure the values are correct
    // Get page status if this is a real page
    let pageStatus = 'active'; // Default to active
    try {
      const page = await storage.getPageByPageId(pageId);
      if (page && page.status) {
        pageStatus = page.status;
        log(`Found page status for ${pageId}: ${pageStatus}`, 'test-endpoints');
      }
    } catch (pageErr) {
      log(`Error getting page status: ${pageErr}`, 'test-endpoints');
    }
    
    const payload = {
      message: testMessage,
      page_id: pageId,
      sender_id: senderId,
      test_mode: true,
      message_count: 1,
      page_status: pageStatus
    };
    log(`Sending payload to Python: ${JSON.stringify(payload)}`, 'test-endpoints');
    
    const response = await fetch(pythonUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      throw new Error(`Python API returned status: ${response.status}`);
    }
    
    // Get response data 
    const responseData = await response.json();
    log(`Python API response: ${JSON.stringify(responseData)}`, 'test-endpoints');
    
    // Add a small delay to ensure database operations complete
    log(`Waiting for database operation to complete...`, 'test-endpoints');
    await new Promise(resolve => setTimeout(resolve, 4000));
    
    // Verify what was saved in the database by querying the Python API directly
    try {
      const pythonCheckUrl = `http://localhost:5000/api/user-state?sender_id=${senderId}`;
      log(`Checking Python API directly: ${pythonCheckUrl}`, 'test-endpoints');
      
      const pythonCheck = await fetch(pythonCheckUrl);
      if (pythonCheck.ok) {
        const pythonData = await pythonCheck.json();
        log(`Python API user state check: ${JSON.stringify(pythonData)}`, 'test-endpoints');
      } else {
        log(`Python API user state check failed: ${pythonCheck.status}`, 'test-endpoints');
      }
    } catch (err) {
      log(`Error checking Python user state: ${err}`, 'test-endpoints');
    }
    
    // Now check if the user state was saved to the database
    const [userState] = await db.query.userStates.findMany({
      where: (fields) => {
        return and(
          eq(fields.senderId, senderId),
          eq(fields.pageId, pageId)
        )
      },
      limit: 1
    });
    
    if (!userState) {
      return res.status(404).json({
        success: false,
        message: 'User state not found in database after test',
        testInfo: { senderId, pageId }
      });
    }
    
    return res.json({
      success: true,
      message: 'User state successfully persisted to database',
      userState,
      testInfo: { senderId, pageId }
    });
  } catch (error: any) {
    log(`Error in test-user-state endpoint: ${error}`, 'test-endpoints');
    return res.status(500).json({
      success: false,
      message: 'Error testing user state persistence',
      error: error.message || String(error)
    });
  }
});

/**
 * Test endpoint to directly test the user state persistence from JavaScript to Python
 * This uses the new testUserStatePersistence function in PythonBridge
 */
router.post('/user-state-persistence', async (req: Request, res: Response) => {
  try {
    // Forward the request directly to pythonBridge.testUserStatePersistence
    return await pythonBridge.testUserStatePersistence(req, res);
  } catch (error: any) {
    log(`Error in user-state-persistence endpoint: ${error}`, 'test-endpoints');
    return res.status(500).json({
      success: false,
      message: 'Error testing JS->Python user state persistence',
      error: error.message || String(error)
    });
  }
});

/**
 * Test endpoint to execute SQL queries directly for testing
 * This endpoint should NOT be accessible in production
 */
router.post('/sql', async (req: Request, res: Response) => {
  try {
    const { sql } = req.body;
    
    if (!sql) {
      return res.status(400).json({ error: 'SQL query is required' });
    }
    
    // Execute the SQL query directly
    const result = await db.execute(sql);
    
    return res.json(result);
  } catch (error: any) {
    log(`Error executing SQL query: ${error}`, 'test-endpoints');
    return res.status(500).json({
      error: 'Error executing SQL query',
      message: error.message || String(error)
    });
  }
});

export default router;