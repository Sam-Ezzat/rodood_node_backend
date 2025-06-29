/**
 * Dashboard API Endpoint
 * Provides metrics data for the insights dashboard via the Python API
 */

import { Request, Response } from 'express';
import fetch from 'node-fetch';
import { log } from '../vite';

/**
 * Handle dashboard metrics request
 * This uses our Python API proxy to get insights data
 */
export async function handleDashboardRequest(req: Request, res: Response) {
  const { pageId, days, timePeriod } = req.query;
  
  if (!pageId) {
    return res.status(400).json({ message: "Page ID is required" });
  }
  
  try {
    log(`[Dashboard] Fetching metrics for pageId=${pageId}, days=${days || 7}, timePeriod=${timePeriod || 'custom'}`, 'dashboard');
    
    // Call Python API via our local proxy (not directly to localhost:5555)
    // In production, use just the path without the host so requests stay on the same server
    // This is critical for proper functionality in the live environment
    const pythonApiUrl = process.env.NODE_ENV === 'production' ?
                        '/api/python/insights' :
                        'http://localhost:5000/api/python/insights';
    
    log(`[Dashboard] Environment: ${process.env.NODE_ENV}`, 'dashboard');
    
    log(`[Dashboard] Using Python API proxy at: ${pythonApiUrl}`, 'dashboard');
    
    const response = await fetch(
      pythonApiUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          page_id: pageId as string,
          days: days ? parseInt(days as string) : 7,
          time_period: timePeriod || 'custom'
        })
      }
    );
    
    if (!response.ok) {
      throw new Error(`Python insights error: ${response.status}`);
    }
    
    // Parse the JSON response with proper type assertion
    const pythonResponse = await response.json();
    
    // Define the expected response structure with proper typing
    type PythonApiResponse = {
      success: boolean;
      error?: string;
      data?: {
        totalConversations?: number;
        totalBotMessages?: number;
        averageResponseTime?: number;
        completionRate?: number;
        conversationTrend?: Array<{date: string; count: number}>;
        sentimentDistribution?: Array<{rank: number; count: number}>;
        timePeriod?: string;  // Added for time period support
        days?: number;        // Number of days in the time period
      }
    };
    
    // Add type checking with defensive programming
    const responseData: PythonApiResponse = {
      success: pythonResponse && typeof pythonResponse === 'object' && 'success' in pythonResponse ? Boolean(pythonResponse.success) : false,
      error: pythonResponse && typeof pythonResponse === 'object' && 'error' in pythonResponse ? String(pythonResponse.error) : undefined,
      data: pythonResponse && typeof pythonResponse === 'object' && 'data' in pythonResponse && pythonResponse.data ? pythonResponse.data : {}
    };
    
    if (!responseData.success) {
      throw new Error(responseData.error || 'Unknown error getting insights');
    }
    
    if (!responseData.data) {
      throw new Error('Python API returned no data');
    }
    
    log('[Dashboard] Python data response received successfully', 'dashboard');
    
    // Structure the response correctly for the frontend with the metrics wrapper
    const metricsResponse = {
      metrics: {
        totalConversations: responseData.data.totalConversations || 0,
        totalBotMessages: responseData.data.totalBotMessages || 0,
        averageResponseTime: responseData.data.averageResponseTime || 0,
        completionRate: responseData.data.completionRate || 0,
        conversationTrend: responseData.data.conversationTrend || [],
        sentimentDistribution: responseData.data.sentimentDistribution || [],
        timePeriod: timePeriod || 'custom',
        days: days ? parseInt(days as string) : 7
      }
    };
    
    log('[Dashboard] Sending response with timePeriod and days included', 'dashboard');
    return res.status(200).json(metricsResponse);
  } catch (error) {
    console.error("Error fetching dashboard metrics:", error);
    return res.status(500).json({ message: "Failed to fetch dashboard metrics" });
  }
}