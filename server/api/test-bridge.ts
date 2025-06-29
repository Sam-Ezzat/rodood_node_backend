/**
 * Test bridge for communicating with the Python API for testing
 */
import { Request, Response } from 'express';
import { pythonBridge } from './python-bridge';
import { log } from '../vite';
import { conversations, messages } from '@shared/schema';
import { db, pool } from '../db';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';

/**
 * Handle testing the greeting message functionality
 */
export async function handleTestGreeting(req: Request, res: Response) {
  try {
    const { sender_id, page_id, conversation_id } = req.body;
    
    if (!sender_id || !page_id) {
      return res.status(400).json({ error: 'Missing required parameters (sender_id, page_id)' });
    }
    
    log(`[TEST] Testing greeting detection for sender_id=${sender_id}, page_id=${page_id}`, 'test-bridge');
    
    // Call the Python API to check the greeting message
    const pythonResponse = await pythonBridge.callPythonApi('/api/check-greeting', {
      sender_id,
      page_id,
      conversation_id
    }, 'POST');
    
    return res.json(pythonResponse);
  } catch (error: any) {
    log(`[TEST] Error in handleTestGreeting: ${error?.message || String(error)}`, 'test-bridge');
    return res.status(500).json({ error: 'Failed to test greeting detection', details: error?.message });
  }
}

/**
 * Create a test conversation for greeting message testing
 */
export async function handleCreateGreetingTest(req: Request, res: Response) {
  try {
    const { sender_id, page_id, messages: messageData } = req.body;
    
    if (!sender_id || !page_id || !messageData || !Array.isArray(messageData)) {
      return res.status(400).json({ error: 'Missing required parameters (sender_id, page_id, messages)' });
    }
    
    log(`[TEST] Creating test conversation for sender_id=${sender_id}, page_id=${page_id}`, 'test-bridge');
    
    // Create the conversation in the database
    const [conversation] = await db
      .insert(conversations)
      .values({
        pageId: page_id,
        senderId: sender_id,
        messagingType: 'RESPONSE',
        status: 'active'
      })
      .returning();
    
    log(`[TEST] Created conversation with ID ${conversation.id}`, 'test-bridge');
    
    // Add the messages to the database
    for (const message of messageData) {
      await db
        .insert(messages)
        .values({
          conversationId: conversation.id,
          sender: message.from?.id === page_id ? 'bot' : 'user',
          text: message.message || '',
          responseTime: message.from?.id === page_id ? 0 : null
        });
    }
    
    log(`[TEST] Added ${messageData.length} messages to conversation`, 'test-bridge');
    
    return res.json({
      success: true,
      conversation_id: conversation.id,
      message: `Created test conversation with ${messageData.length} messages`
    });
  } catch (error: any) {
    log(`[TEST] Error in handleCreateGreetingTest: ${error?.message || String(error)}`, 'test-bridge');
    return res.status(500).json({ error: 'Failed to create test conversation', details: error?.message });
  }
}

/**
 * Create a test conversation with specific messages for our greeting test script
 */
export async function handleCreateTestConversation(req: Request, res: Response) {
  try {
    const { sender_id, page_id, messages } = req.body;
    
    if (!sender_id || !page_id || !messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing required parameters (sender_id, page_id, messages)' });
    }
    
    log(`[TEST] Creating test conversation for greeting test: sender_id=${sender_id}, page_id=${page_id}`, 'test-bridge');
    
    // Delete any existing conversation for this sender and page
    await db
      .delete(conversations)
      .where(
        eq(conversations.senderId, sender_id) && 
        eq(conversations.pageId, page_id)
      );
    
    // Create new conversation
    const [conversation] = await db
      .insert(conversations)
      .values({
        pageId: page_id,
        senderId: sender_id,
        messagingType: 'RESPONSE',
        status: 'active'
      })
      .returning();
    
    log(`[TEST] Created conversation with ID ${conversation.id}`, 'test-bridge');
    
    // Add messages to the database using raw SQL
    for (const message of messages) {
      try {
        const query = `
          INSERT INTO messages (conversation_id, sender, text, response_time) 
          VALUES ($1, $2, $3, $4)
        `;
        const values = [
          conversation.id,
          message.sender || 'user',
          message.text || '',
          message.sender === 'bot' ? 0 : null
        ];
        
        // Use the PostgreSQL pool directly
        await pool.query(query, values);
        
      } catch (error) {
        log(`[TEST] Error inserting message: ${error}`, 'test-bridge');
        throw error;
      }
    }
    
    log(`[TEST] Added ${messages.length} messages to conversation`, 'test-bridge');
    
    return res.json({
      success: true,
      conversation_id: conversation.id,
      sender_id: sender_id,
      page_id: page_id,
      message_count: messages.length,
      message: `Created test conversation with ${messages.length} messages`
    });
  } catch (error: any) {
    log(`[TEST] Error in handleCreateTestConversation: ${error?.message || String(error)}`, 'test-bridge');
    return res.status(500).json({ error: 'Failed to create test conversation', details: error?.message });
  }
}