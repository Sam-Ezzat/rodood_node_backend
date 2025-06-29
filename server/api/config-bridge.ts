/**
 * This file contains functions that bridge between the database config
 * and the Python-based chatbot configuration.
 */

import { Express, Request, Response } from 'express';
import { storage } from '../storage';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../vite';

// Import cache from routes.ts - we'll need to access the configCache
declare global {
  var configCache: Map<string, any>;
}

// Helper function to clear cache for a page
function clearPageCache(pageId: string) {
  if (typeof global.configCache !== 'undefined') {
    const configCacheKey = `config_${pageId}`;
    const pageCacheKey = `page_${pageId}`;
    global.configCache.delete(configCacheKey);
    global.configCache.delete(pageCacheKey);
    console.log(`[Cache] Cleared cache for page ${pageId} after configuration update`);
  }
}

interface PageConfig {
  page_id: string;
  access_token: string;
  assistant_id?: string;
  greeting_message?: string;
  first_message?: string;
  max_messages?: number;
  end_message?: string;
  stop_message?: string;
}

/**
 * Get configuration for a specific page ID
 * Instagram is now handled as a separate app, no mapping needed
 */
export async function getPageConfig(pageId: string): Promise<PageConfig | null> {
  try {
    const page = await storage.getPageById(pageId);
    
    if (!page) {
      console.error(`Page with ID ${pageId} not found in database`);
      return null;
    }
    
    // Extract configuration from page metadata
    const metadata = page.metadata as {
      greetingMessage?: string;
      firstMessage?: string;
      maxMessages?: number;
      endMessage?: string;
      stopMessage?: string;
    } || {};
    
    const config: PageConfig = {
      page_id: page.pageId,
      access_token: page.accessToken,
      assistant_id: page.assistantId || undefined,
      greeting_message: metadata.greetingMessage || '',
      first_message: metadata.firstMessage || 'honored to know your name and where are you from?',
      max_messages: metadata.maxMessages || 10,
      end_message: metadata.endMessage || 'Excuse me i need to go, we will continue our talk later',
      stop_message: metadata.stopMessage || '*',
    };
    
    return config;
  } catch (error) {
    console.error('Error getting page configuration:', error);
    return null;
  }
}

/**
 * Instagram is now treated as a separate app, no mapping needed
 * This function is kept as a placeholder for backward compatibility
 */
export async function getInstagramInfo(): Promise<Record<string, string>> {
  return {};
}

/**
 * Get a specific configuration value for a page
 */
export async function getPageConfigValue(pageId: string, key: string): Promise<any> {
  const config = await getPageConfig(pageId);
  if (!config) return null;
  
  return (config as any)[key];
}

/**
 * Add an API endpoint to expose page configurations to the Python server
 */
export function setupConfigBridgeEndpoints(app: Express) {
  // Get configuration for a specific page
  app.get('/api/config/page/:pageId', async (req: Request, res: Response) => {
    try {
      const pageId = req.params.pageId;
      const config = await getPageConfig(pageId);
      
      if (!config) {
        return res.status(404).json({ 
          success: false, 
          error: `Page with ID ${pageId} not found` 
        });
      }
      
      return res.status(200).json({
        success: true,
        config,
      });
    } catch (error) {
      console.error('Error getting page configuration:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to get page configuration' 
      });
    }
  });
  
  // Instagram info endpoint (no mapping needed anymore)
  app.get('/api/config/instagram-info', async (req: Request, res: Response) => {
    try {
      // Instagram is now a separate app, not mapped to Facebook
      const instagramInfo = await getInstagramInfo();
      
      return res.status(200).json({
        success: true,
        message: 'Instagram is now handled as a separate app',
        info: instagramInfo
      });
    } catch (error) {
      console.error('Error getting Instagram info:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to get Instagram info' 
      });
    }
  });
  
  // Get a specific configuration value for a page
  app.get('/api/config/page/:pageId/:key', async (req: Request, res: Response) => {
    try {
      const { pageId, key } = req.params;
      const value = await getPageConfigValue(pageId, key);
      
      if (value === null || value === undefined) {
        return res.status(404).json({ 
          success: false, 
          error: `Configuration value '${key}' not found for page ${pageId}` 
        });
      }
      
      return res.status(200).json({
        success: true,
        value,
      });
    } catch (error) {
      console.error('Error getting configuration value:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to get configuration value' 
      });
    }
  });
  
  // Update page configuration via PATCH (for internal API use)
  app.patch('/api/pages/:pageId/config', async (req: Request, res: Response) => {
    try {
      // Get user ID from header directly since this endpoint is registered before auth middleware
      const userId = req.headers['x-user-id'];
      
      if (!userId) {
        return res.status(401).json({ message: 'Authentication required' });
      }
      
      // Get user from storage directly
      const userIdNum = parseInt(userId as string, 10);
      if (isNaN(userIdNum)) {
        return res.status(401).json({ message: 'Invalid user ID' });
      }
      
      const user = await storage.getUser(userIdNum);
      if (!user) {
        return res.status(401).json({ message: 'User not found' });
      }
      
      if (!user.isAdmin) {
        return res.status(403).json({ message: 'Administrator privileges required' });
      }
      
      const { pageId } = req.params;
      const { assistantId, metadata } = req.body;
      
      const page = await storage.getPageById(pageId);
      if (!page) {
        return res.status(404).json({ message: `Page with ID ${pageId} not found` });
      }
      
      // Update the page configuration
      const existingMetadata = (page.metadata as Record<string, any>) || {};
      const newMetadata = (metadata as Record<string, any>) || {};
      
      const result = await storage.updatePage(pageId, {
        assistantId,
        metadata: {
          ...existingMetadata, // Keep existing metadata
          ...newMetadata,      // Update with new values
        },
      });
      
      // Clear cache for this page configuration
      clearPageCache(pageId);
      
      // Log the updated configuration
      log(`Updated configuration for page ${pageId}`, 'config-bridge');
      
      return res.status(200).json({
        success: true,
        message: 'Page configuration updated successfully',
        page: result,
      });
    } catch (error) {
      console.error('Error updating page configuration:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to update page configuration',
        error: (error as Error).message,
      });
    }
  });
  
  // Update page configuration via PUT (for frontend direct calls)
  app.put('/api/config-bridge/page/:id/config', async (req: Request, res: Response) => {
    try {
      // Get user ID from header directly since this endpoint is registered before auth middleware
      const userId = req.headers['x-user-id'];
      
      if (!userId) {
        return res.status(401).json({ message: 'Authentication required' });
      }
      
      // Get user from storage directly
      const userIdNum = parseInt(userId as string, 10);
      if (isNaN(userIdNum)) {
        return res.status(401).json({ message: 'Invalid user ID' });
      }
      
      const user = await storage.getUser(userIdNum);
      if (!user) {
        return res.status(401).json({ message: 'User not found' });
      }
      
      if (!user.isAdmin) {
        return res.status(403).json({ message: 'Administrator privileges required' });
      }
      
      const pageId = parseInt(req.params.id, 10);
      if (isNaN(pageId)) {
        return res.status(400).json({ message: 'Invalid page ID' });
      }
      
      const page = await storage.getPage(pageId);
      if (!page) {
        return res.status(404).json({ message: `Page with ID ${pageId} not found` });
      }
      
      const {
        assistantId,
        greetingMessage,
        firstMessage,
        maxMessages,
        endMessage,
        stopMessage
      } = req.body;
      
      // Update the page configuration
      const metadata = (page.metadata as Record<string, any>) || {};
      const result = await storage.updatePage(page.pageId, {
        assistantId,
        metadata: {
          ...metadata, // Keep existing metadata
          greetingMessage,
          firstMessage,
          maxMessages,
          endMessage,
          stopMessage
        },
      });
      
      // Clear cache for this page configuration
      clearPageCache(page.pageId);
      
      // Log the updated configuration
      log(`Updated configuration for page ${pageId}`, 'config-bridge');
      
      return res.status(200).json({
        success: true,
        message: 'Page configuration updated successfully',
        page: result,
      });
    } catch (error) {
      console.error('Error updating page configuration:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to update page configuration',
        error: (error as Error).message,
      });
    }
  });

  // Cache invalidation endpoint for Python configuration refresh
  app.post('/api/config/refresh/:pageId', async (req: Request, res: Response) => {
    try {
      const { pageId } = req.params;
      
      // Clear Node.js cache
      clearPageCache(pageId);
      
      // Call Python server to refresh its cache
      const fetch = (await import('node-fetch')).default;
      try {
        const pythonResponse = await fetch(`http://localhost:5555/api/config/refresh/${pageId}`, {
          method: 'POST',
          timeout: 5000
        });
        
        if (pythonResponse.ok) {
          console.log(`[Cache] Successfully refreshed Python cache for page ${pageId}`);
        } else {
          console.log(`[Cache] Python cache refresh failed for page ${pageId}: ${pythonResponse.statusText}`);
        }
      } catch (pythonError) {
        console.log(`[Cache] Python cache refresh error for page ${pageId}:`, pythonError);
      }
      
      return res.status(200).json({
        success: true,
        message: `Cache refreshed for page ${pageId}`,
        pageId
      });
    } catch (error) {
      console.error('Error refreshing cache:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to refresh cache' 
      });
    }
  });

  log('Config bridge endpoints initialized', 'config-bridge');
}