/**
 * API endpoints for dashboard insights calculations
 * Handles fetching, comparing, and generating insights across different time periods
 */

import { Router } from 'express';
import { storage } from '../storage';
import { 
  getTimeRanges, 
  getOrGenerateInsights, 
  compareInsightsPeriods, 
  generateAllPeriodInsights,
  getTimeComparisonInsights
} from '../insights-calculator';

const router = Router();

/**
 * Fetch insights for a particular page and time period
 * GET /api/insights/:pageId/:timePeriod
 */
router.get('/:pageId/:timePeriod', async (req, res) => {
  try {
    const { pageId, timePeriod } = req.params;
    const refresh = req.query.refresh === 'true';
    
    // Check if page exists
    const page = await storage.getPageByPageId(pageId);
    if (!page) {
      return res.status(404).json({ error: 'Page not found' });
    }
    
    // Validate time period
    const validPeriods = ['day', 'week', 'month', 'year'];
    if (!validPeriods.includes(timePeriod)) {
      return res.status(400).json({ 
        error: 'Invalid time period', 
        message: `Time period must be one of: ${validPeriods.join(', ')}` 
      });
    }
    
    // Check if we need to force refresh the insights
    if (refresh) {
      // Get time range for the requested period
      const timeRange = getTimeRanges(timePeriod).current;
      
      // Delete existing insights for this period if they exist
      const existingInsight = await storage.getDashboardInsight(pageId, timePeriod);
      if (existingInsight) {
        // In a real system with proper database migrations, we'd use:
        // await storage.deleteDashboardInsight(existingInsight.id);
        // But for now, we'll just update the existing insight with a dummy value
        // and then regenerate it
        await storage.updateDashboardInsight(existingInsight.id, {
          totalConversations: 0 // This is just to mark it as "deleted"
        });
      }
      
      // Generate new insights
      const insights = await getOrGenerateInsights(pageId, timeRange);
      return res.json(insights);
    } else {
      // Fetch existing or generate new insights
      const insights = await getTimeComparisonInsights(pageId, timePeriod);
      return res.json(insights);
    }
  } catch (error) {
    console.error('Error fetching insights:', error);
    return res.status(500).json({ 
      error: 'Error fetching insights', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

/**
 * Generate insights for all time periods
 * GET /api/insights/:pageId/generate/all
 */
router.get('/:pageId/generate/all', async (req, res) => {
  try {
    const { pageId } = req.params;
    
    // Check if page exists
    const page = await storage.getPageByPageId(pageId);
    if (!page) {
      return res.status(404).json({ error: 'Page not found' });
    }
    
    // Generate insights for all periods
    const insights = await generateAllPeriodInsights(pageId);
    return res.json(insights);
  } catch (error) {
    console.error('Error generating insights:', error);
    return res.status(500).json({ 
      error: 'Error generating insights', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

/**
 * Compare insights between current and previous period
 * GET /api/insights/:pageId/compare/:timePeriod
 */
router.get('/:pageId/compare/:timePeriod', async (req, res) => {
  try {
    const { pageId, timePeriod } = req.params;
    
    // Check if page exists
    const page = await storage.getPageByPageId(pageId);
    if (!page) {
      return res.status(404).json({ error: 'Page not found' });
    }
    
    // Validate time period
    const validPeriods = ['day', 'week', 'month', 'year'];
    if (!validPeriods.includes(timePeriod)) {
      return res.status(400).json({ 
        error: 'Invalid time period', 
        message: `Time period must be one of: ${validPeriods.join(', ')}` 
      });
    }
    
    // Compare insights between periods
    const comparison = await compareInsightsPeriods(pageId, timePeriod);
    return res.json(comparison);
  } catch (error) {
    console.error('Error comparing insights:', error);
    return res.status(500).json({ 
      error: 'Error comparing insights', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

export default router;