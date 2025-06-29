/**
 * Python API Proxy
 * Provides a consistent way to access the Python Flask API from both local and production environments
 */

import { Request, Response, NextFunction, Router } from 'express';
import fetch from 'node-fetch';
import { log } from '../vite';
import { storage } from '../storage';

// Configure the Python API base URL
// Use port 5555 where the Python server is actually running
// In production, we use a relative URL that will be handled by the same host
// The condition below ensures we use the correct URL format in both environments
const PYTHON_API_BASE_URL = process.env.PYTHON_API_URL || 
  (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5555');

// Log the Python API base URL for debugging
console.log(`Configured Python API base URL: ${PYTHON_API_BASE_URL || '(using relative URL)'}`);

/**
 * Create proxy middleware for Python API routes
 * This handles forwarding requests to the Python server and returning responses
 */
export function createPythonApiProxy() {
  const router = Router();
  
  // Use the storage directly from the imported module
  // We're using ES modules, not CommonJS
  
  // Log all requests to the Python API
  router.use((req: Request, res: Response, next: NextFunction) => {
    log(`Python API Proxy: ${req.method} ${req.url}`, 'python-proxy');
    next();
  });
  
  // Handle insights endpoint
  router.post('/insights', async (req: Request, res: Response) => {
    try {
      log(`Proxying insights request to Python API: ${JSON.stringify(req.body)}`, 'python-proxy');
      
      const response = await fetch(`${PYTHON_API_BASE_URL}/api/insights`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(req.body)
      });
      
      if (!response.ok) {
        log(`Python API error: ${response.status} ${response.statusText}`, 'python-proxy');
        return res.status(response.status).json({
          success: false,
          error: `Python API error: ${response.status} ${response.statusText}`
        });
      }
      
      const data = await response.json();
      log(`Python API response received`, 'python-proxy');
      
      return res.status(200).json(data);
    } catch (error) {
      log(`Error proxying insights request: ${error}`, 'python-proxy');
      return res.status(500).json({
        success: false,
        error: `Error proxying insights request: ${error}`
      });
    }
  });
  
  // Handle analyze-sentiment endpoint for testing sentiment analysis
  router.post('/analyze-sentiment', async (req: Request, res: Response) => {
    try {
      log(`Proxying sentiment analysis request to Python API: ${JSON.stringify(req.body)}`, 'python-proxy');
      
      const response = await fetch(`${PYTHON_API_BASE_URL}/api/analyze-sentiment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(req.body)
      });
      
      if (!response.ok) {
        log(`Python API error: ${response.status} ${response.statusText}`, 'python-proxy');
        return res.status(response.status).json({
          success: false,
          error: `Python API error: ${response.status} ${response.statusText}`
        });
      }
      
      const data = await response.json();
      log(`Python API sentiment analysis response received`, 'python-proxy');
      
      return res.status(200).json(data);
    } catch (error) {
      log(`Error proxying sentiment analysis request: ${error}`, 'python-proxy');
      return res.status(500).json({
        success: false,
        error: `Error proxying sentiment analysis request: ${error}`
      });
    }
  });

  // Handle message endpoint
  router.post('/message', async (req: Request, res: Response) => {
    try {
      log(`Proxying message request to Python API: ${JSON.stringify(req.body)}`, 'python-proxy');
      
      // If page_id is provided, check the page status from database
      let pageStatus = 'active'; // Default to active
      if (req.body.page_id) {
        try {
          const page = await storage.getPageByPageId(req.body.page_id);
          if (page && page.status) {
            pageStatus = page.status;
            log(`Found page status for ${req.body.page_id}: ${pageStatus}`, 'python-proxy');
          }
        } catch (pageErr) {
          log(`Error getting page status: ${pageErr}`, 'python-proxy');
        }
      }
      
      // Enrich the request with page status
      const enrichedBody = {
        ...req.body,
        page_status: pageStatus
      };
      
      const response = await fetch(`${PYTHON_API_BASE_URL}/api/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(enrichedBody)
      });
      
      if (!response.ok) {
        log(`Python API error: ${response.status} ${response.statusText}`, 'python-proxy');
        return res.status(response.status).json({
          success: false,
          error: `Python API error: ${response.status} ${response.statusText}`
        });
      }
      
      const data = await response.json();
      log(`Python API response received`, 'python-proxy');
      
      return res.status(200).json(data);
    } catch (error) {
      log(`Error proxying message request: ${error}`, 'python-proxy');
      return res.status(500).json({
        success: false,
        error: `Error proxying message request: ${error}`
      });
    }
  });
  
  return router;
}