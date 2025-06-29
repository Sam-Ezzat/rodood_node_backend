import express, { type Request, type Response } from "express";
import { storage } from "../storage";
import { getTimeRanges, getOrGenerateInsights, refreshAllInsightsData } from "../insights-calculator";

const publicRouter = express.Router();

// Public endpoint for all pages (no authentication required)
publicRouter.get("/all-pages", async (req, res) => {
  try {
    console.log('[Public] Fetching all pages without authentication check');
    const allPages = await storage.getAllPages();
    
    console.log('[Public] Retrieved pages count:', allPages.length);
    
    // For security, we'll filter the data to exclude sensitive info like tokens
    const sanitizedPages = allPages.map(page => ({
      id: page.id,
      pageId: page.pageId,
      name: page.name, 
      platform: page.platform,
      accessToken: page.accessToken ? `${page.accessToken.substring(0, 10)}...` : null,
      status: page.status,
      assistantId: page.assistantId,
      metadata: page.metadata,
      createdAt: page.createdAt
    }));
    
    return res.status(200).json(sanitizedPages);
  } catch (error) {
    console.error("Error fetching all pages:", error);
    return res.status(500).json({ message: "Failed to fetch pages" });
  }
});

// Public dashboard API endpoint (no authentication required)
// This now uses our Drizzle database instead of the Python API
publicRouter.get("/dashboard", async (req, res) => {
  console.log('=== DASHBOARD ENDPOINT EXECUTION TRACE (START) ===');
  const { pageId, days, refresh, timePeriod, startDate, endDate } = req.query;
  
  if (!pageId) {
    return res.status(400).json({ message: "Page ID is required" });
  }
  
  // Validate time period if provided
  const validPeriods = ['day', 'week', 'month', 'year', 'custom'];
  const selectedTimePeriod = timePeriod as string || 'week';
  if (timePeriod && !validPeriods.includes(selectedTimePeriod)) {
    return res.status(400).json({ message: `Invalid time period. Must be one of: ${validPeriods.join(', ')}` });
  }
  
  try {
    console.log(`[Public] Fetching dashboard metrics using JS database for pageId=${pageId}, days=${days || 7}, refresh=${refresh || false}, timePeriod=${selectedTimePeriod}`);
    if (startDate && endDate) {
      console.log(`[Public] Custom date range: ${startDate} to ${endDate}`);
    }
    
    // Check if the page exists
    const page = await storage.getPageByPageId(pageId as string);
    if (!page) {
      return res.status(404).json({ message: "Page not found" });
    }
    
    // Define the time period based on the request
    // If not specified, we'll determine based on days
    let effectiveTimePeriod = selectedTimePeriod;
    
    // Convert from 'custom' to standard periods if matching days count
    if (effectiveTimePeriod === 'custom' && days && !startDate && !endDate) {
      const daysInt = parseInt(days as string);
      if (daysInt === 1) effectiveTimePeriod = 'day';
      else if (daysInt === 7) effectiveTimePeriod = 'week';
      else if (daysInt === 30) effectiveTimePeriod = 'month';
      else if (daysInt === 365) effectiveTimePeriod = 'year';
    }
    
    // If refresh is requested, remove any existing metrics
    const shouldRefresh = refresh === 'true';
    if (shouldRefresh) {
      // For custom period, we don't have a stored insight since dates can vary
      if (effectiveTimePeriod !== 'custom') {
        const existingInsight = await storage.getDashboardInsight(pageId as string, effectiveTimePeriod);
        if (existingInsight && existingInsight.id) {
          console.log(`[Public] Refreshing insights for ${pageId} in ${effectiveTimePeriod} period`);
          await storage.deleteDashboardInsight(existingInsight.id);
        }
      }
    }
    
    // Get the time ranges for the period
    let timeRange;
    
    // Handle custom date range if both start and end dates are provided
    if (effectiveTimePeriod === 'custom' && startDate && endDate) {
      const customStartDate = new Date(startDate as string);
      const customEndDate = new Date(endDate as string);
      
      if (isNaN(customStartDate.getTime()) || isNaN(customEndDate.getTime())) {
        return res.status(400).json({ 
          message: "Invalid date format. Please use YYYY-MM-DD format for custom date range." 
        });
      }
      
      timeRange = getTimeRanges('custom', new Date(), customStartDate, customEndDate).current;
      console.log(`[Public] Using custom date range: ${customStartDate.toISOString()} to ${customEndDate.toISOString()}`);
    } else {
      timeRange = getTimeRanges(effectiveTimePeriod).current;
    }
    
    // Get or generate the insights
    const insight = await getOrGenerateInsights(pageId as string, timeRange);
    
    if (!insight) {
      console.error(`[Public] Failed to get or generate insights for ${pageId}`);
      return res.status(500).json({ message: "Failed to generate insights" });
    }
    
    // Always get fresh authentic sentiment data directly from database
    console.log(`[Public] Forcing fresh sentiment data retrieval from database for page ${pageId}`);
    const sentimentData = await storage.getSentimentDistribution(
      pageId as string,
      timeRange.startDate,
      timeRange.endDate
    );
    
    const totalSentimentItems = sentimentData.reduce((sum: number, item: {count: number}) => sum + item.count, 0);
    console.log(`[Public] Retrieved authentic sentiment data with ${totalSentimentItems} total conversations analyzed`);
    console.log(`[Public] Sentiment breakdown:`, sentimentData.map((item: any) => `${item.sentiment}:${item.count}`).join(', '));
    
    // Format the response for the frontend
    const metricsResponse = {
      metrics: {
        timePeriod: effectiveTimePeriod,
        days: parseInt(days as string) || 
              (effectiveTimePeriod === 'day' ? 1 : 
               effectiveTimePeriod === 'week' ? 7 : 
               effectiveTimePeriod === 'month' ? 30 : 
               effectiveTimePeriod === 'year' ? 365 : 7),
        totalConversations: insight.totalConversations,
        totalBotMessages: insight.totalMessages,
        averageResponseTime: insight.averageResponseTime,
        completionRate: insight.completionRate,
        conversationTrend: insight.conversationTrend || [{ date: new Date().toISOString().split('T')[0], count: 0 }],
        // Use real-time sentiment data instead of cached data in the insight
        // Ensure that each rank from 1 to 5 is represented in the distribution
        sentimentDistribution: (() => {
          // Create a map to hold our distribution with ranks as keys
          const rankMap: Record<string, {rank: number, count: number, label: string}> = {};
          
          // Initialize all ranks with zero counts
          for (let rank = 1; rank <= 5; rank++) {
            rankMap[rank] = {
              rank,
              count: 0,
              label: `Rank ${rank.toFixed(1)} / 5.0`
            };
          }
          
          // Add the actual distribution data, overriding the default values
          sentimentData.forEach((item: any) => {
            if (item.rank >= 1 && item.rank <= 5) {
              const rankKey = Math.round(item.rank).toString();
              rankMap[rankKey] = {
                rank: item.rank,
                count: item.count,
                label: item.label || `Rank ${item.rank.toFixed(1)} / 5.0`
              };
            }
          });
          
          // Convert the map back to an array and sort by rank
          return Object.values(rankMap).sort((a, b) => a.rank - b.rank);
        })()
      }
    };
    
    // Log what we're sending
    console.log('[Public] Sending metrics to client:', JSON.stringify({
      timePeriod: metricsResponse.metrics.timePeriod,
      days: metricsResponse.metrics.days,
      totalConversations: metricsResponse.metrics.totalConversations,
      conversationTrendCount: Array.isArray(metricsResponse.metrics.conversationTrend) ? metricsResponse.metrics.conversationTrend.length : 0,
      sentimentDistributionCount: Array.isArray(metricsResponse.metrics.sentimentDistribution) ? metricsResponse.metrics.sentimentDistribution.length : 0
    }, null, 2));
    
    console.log('=== DASHBOARD ENDPOINT EXECUTION TRACE (BEFORE RETURN) ===');
    console.log('[Public] Using database insights data directly!');
    
    return res.status(200).json(metricsResponse);
  } catch (error) {
    console.error("Error fetching dashboard metrics:", error);
    return res.status(500).json({ message: "Failed to fetch dashboard metrics" });
  }
});

// New test endpoint to verify we can add time period fields
publicRouter.get("/test-timePeriod", (req, res) => {
  console.log("=== TEST TIME PERIOD ENDPOINT ACCESSED ===");
  
  // Create a direct response with the fields
  const timePeriodValue = req.query.timePeriod as string || 'week';
  const daysValue = req.query.days ? parseInt(req.query.days as string) : 7;
  
  // Create direct JSON string with guaranteed fields
  const jsonResponse = `{
    "metrics": {
      "timePeriod": "${timePeriodValue}",
      "days": ${daysValue},
      "totalConversations": 123,
      "totalBotMessages": 456,
      "testField": "This is a test endpoint"
    }
  }`;
  
  console.log("Sending response with timePeriod:", timePeriodValue);
  console.log("JSON contains timePeriod:", jsonResponse.includes('"timePeriod"'));
  
  // Send raw JSON
  res.setHeader('Content-Type', 'application/json');
  return res.send(jsonResponse);
});

// refreshAllInsightsData is already imported at the top

// Endpoint to refresh all insights data for all pages
publicRouter.post("/refresh-all-insights", async (req, res) => {
  try {
    console.log("[Public] Starting full insights data refresh for all pages");
    
    // Optional authentication check
    // For production, you might want to restrict this to admin users
    // Here we're keeping it simple for the demo
    
    // Trigger full refresh of all insights data
    await refreshAllInsightsData();
    
    return res.status(200).json({ 
      success: true, 
      message: "Successfully refreshed all insights data",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("[Public] Error refreshing insights data:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Failed to refresh insights data", 
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

// Endpoint to refresh insights for a specific page and time period
publicRouter.post("/refresh-page-insights/:pageId/:timePeriod", async (req, res) => {
  try {
    const { pageId, timePeriod } = req.params;
    
    if (!pageId || !timePeriod) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: pageId and timePeriod"
      });
    }
    
    // Validate time period
    const validPeriods = ['day', 'week', 'month', 'year'];
    if (!validPeriods.includes(timePeriod)) {
      return res.status(400).json({
        success: false,
        message: "Invalid time period. Must be one of: day, week, month, year"
      });
    }
    
    console.log(`[Public] Refreshing insights for page ${pageId}, period ${timePeriod}`);
    
    // Get time ranges for this period
    const timeRange = getTimeRanges(timePeriod).current;
    
    // Delete existing insights first
    await storage.deleteDashboardInsight(pageId, timePeriod);
    
    // Generate new insights with force refresh
    const insights = await getOrGenerateInsights(pageId, timeRange, true);
    
    return res.status(200).json({
      success: true,
      message: `Successfully refreshed ${timePeriod} insights for page ${pageId}`,
      insights,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`[Public] Error refreshing page insights:`, error);
    return res.status(500).json({
      success: false,
      message: "Failed to refresh page insights",
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

export default publicRouter;