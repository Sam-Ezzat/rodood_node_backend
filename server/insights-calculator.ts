/**
 * Utility functions for calculating dashboard insights across different time periods
 * This module handles aggregation, calculation, and comparison of metrics
 */

import { storage } from './storage';
import { DashboardInsight, SentimentDistribution } from '@shared/schema';
import { format, subDays, subMonths, subYears, startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear } from 'date-fns';

export interface TimeRange {
  startDate: Date;
  endDate: Date;
  timePeriod: string;
  label: string;
}

export interface InsightComparison {
  current: DashboardInsight | null;
  previous: DashboardInsight | null;
  changes: {
    totalConversations: { value: number; percentage: number };
    totalMessages: { value: number; percentage: number };
    averageResponseTime: { value: number; percentage: number };
    completionRate: { value: number; percentage: number };
    sentimentPositive: { value: number; percentage: number };
    sentimentNeutral: { value: number; percentage: number };
    sentimentNegative: { value: number; percentage: number };
    averageSentiment: { value: number; percentage: number };
  };
}

/**
 * Get time ranges for different periods based on the current date
 * @param timePeriod The time period to calculate ranges for ('day', 'week', 'month', 'year', 'custom')
 * @param referenceDate The reference date (default is current date)
 * @param customStartDate Optional custom start date for 'custom' time period
 * @param customEndDate Optional custom end date for 'custom' time period
 * @returns An object with current and previous time ranges
 */
export function getTimeRanges(
  timePeriod: string, 
  referenceDate: Date = new Date(),
  customStartDate?: Date,
  customEndDate?: Date
): { current: TimeRange; previous: TimeRange } {
  let currentStart: Date;
  let currentEnd: Date;
  let previousStart: Date;
  let previousEnd: Date;
  let label: string;

  // For logging during development
  console.log(`[Insights] Calculating time ranges for period: ${timePeriod} with reference date: ${referenceDate.toISOString()}`);
  if (customStartDate && customEndDate) {
    console.log(`[Insights] Custom date range: ${customStartDate.toISOString()} to ${customEndDate.toISOString()}`);
  }

  switch (timePeriod) {
    case 'day':
      // Today: Just the current day
      currentStart = startOfDay(referenceDate);
      currentEnd = endOfDay(referenceDate);
      previousStart = startOfDay(subDays(referenceDate, 1));
      previousEnd = endOfDay(subDays(referenceDate, 1));
      label = 'Today';
      break;

    case 'week':
      // Last 7 Days: Rolling 7 days (not calendar week)
      currentEnd = endOfDay(referenceDate);
      currentStart = startOfDay(subDays(referenceDate, 6)); // 6 days ago plus today = 7 days
      previousEnd = endOfDay(subDays(referenceDate, 7));
      previousStart = startOfDay(subDays(referenceDate, 13)); // Previous 7 days
      label = `Last 7 Days`;
      break;

    case 'month':
      // Last 30 Days: Rolling 30 days (not calendar month)
      currentEnd = endOfDay(referenceDate);
      currentStart = startOfDay(subDays(referenceDate, 29)); // 29 days ago plus today = 30 days
      previousEnd = endOfDay(subDays(referenceDate, 30));
      previousStart = startOfDay(subDays(referenceDate, 59)); // Previous 30 days
      label = `Last 30 Days`;
      break;

    case 'year':
      // Year to Date: From Jan 1st of current year to today
      currentEnd = endOfDay(referenceDate);
      currentStart = startOfYear(referenceDate);
      // Previous period is same date range but in previous year
      const daysFromYearStart = Math.floor((referenceDate.getTime() - currentStart.getTime()) / (1000 * 60 * 60 * 24));
      previousEnd = endOfDay(subYears(referenceDate, 1));
      previousStart = startOfDay(subDays(previousEnd, daysFromYearStart));
      label = `Year to Date`;
      break;
      
    case 'custom':
      // Handle custom date range
      if (!customStartDate || !customEndDate) {
        throw new Error('Custom date range requires both start and end dates');
      }
      
      currentStart = startOfDay(customStartDate);
      currentEnd = endOfDay(customEndDate);
      
      // For previous period, use the same length of time but shifted back
      const daysDiff = Math.floor((customEndDate.getTime() - customStartDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      previousEnd = endOfDay(subDays(customStartDate, 1));
      previousStart = startOfDay(subDays(previousEnd, daysDiff - 1));
      
      label = `Custom Range`;
      break;

    default:
      throw new Error(`Unknown time period: ${timePeriod}`);
  }

  return {
    current: {
      startDate: currentStart,
      endDate: currentEnd,
      timePeriod,
      label
    },
    previous: {
      startDate: previousStart,
      endDate: previousEnd,
      timePeriod,
      label: timePeriod === 'day' ? 'Yesterday' : 
             timePeriod === 'week' ? 'Previous 7 Days' :
             timePeriod === 'month' ? 'Previous 30 Days' :
             timePeriod === 'year' ? 'Previous Year to Date' :
             timePeriod === 'custom' ? 'Previous Custom Period' :
             'Previous Period'
    }
  };
}

/**
 * Calculate the percentage change between two values
 * @param current Current value
 * @param previous Previous value
 * @returns Percentage change (positive or negative)
 */
export function calculatePercentageChange(current: number, previous: number): number {
  if (previous === 0) {
    return current > 0 ? 100 : 0; // If previous was 0, any positive value is a 100% increase
  }
  return ((current - previous) / previous) * 100;
}

/**
 * Gets existing insights for a page and time period, or generates them if they don't exist
 * @param pageId The ID of the Facebook page
 * @param timeRange The time range to get insights for
 * @param refresh Optional flag to force regeneration of insights even if they exist
 * @returns Promise resolving to the dashboard insight
 */
export async function getOrGenerateInsights(pageId: string, timeRange: TimeRange, refresh: boolean = false): Promise<DashboardInsight | null> {
  console.log(`[Insights] Getting insights for page ${pageId}, period ${timeRange.timePeriod}`);
  console.log(`[Insights] Time range: ${timeRange.startDate.toISOString()} to ${timeRange.endDate.toISOString()}`);
  console.log(`[Insights] Label: ${timeRange.label}, Refresh requested: ${refresh}`);
  
  // First, try to find existing insights in the database (unless refresh is requested)
  if (!refresh) {
    const existingInsight = await storage.getDashboardInsight(pageId, timeRange.timePeriod);
    
    if (existingInsight) {
      // Check if insights are still valid (within the date range)
      const now = new Date();
      if (existingInsight.endDate >= now) {
        console.log(`[Insights] Found valid existing insight for ${pageId}, period ${timeRange.timePeriod}`);
        console.log(`[Insights] Existing time range: ${existingInsight.startDate.toISOString()} to ${existingInsight.endDate.toISOString()}`);
        return existingInsight;
      }
      console.log(`[Insights] Found existing insight but it's outdated for ${pageId}, period ${timeRange.timePeriod}`);
    } else {
      console.log(`[Insights] No existing insight found for ${pageId}, period ${timeRange.timePeriod}`);
    }
  } else {
    // If refresh is requested, delete any existing insights for this page and time period
    console.log(`[Insights] Forcing refresh of insights for page ${pageId}, period ${timeRange.timePeriod}`);
    await storage.deleteDashboardInsight(pageId, timeRange.timePeriod);
  }
  
  // If no valid insights were found, calculate new ones
  try {
    // Get conversation data
    const conversations = await storage.getConversationsByPageId(pageId);
    
    // Filter to only include conversations in the time range
    const conversationsInRange = conversations.filter(convo => {
      if (!convo.createdAt) return false;
      
      const convoDate = convo.createdAt instanceof Date 
        ? convo.createdAt 
        : new Date(convo.createdAt);
      return convoDate >= timeRange.startDate && convoDate <= timeRange.endDate;
    });
    
    // Calculate conversation count trend
    const conversationTrend: Array<{date: string, count: number}> = [];
    const dateMap = new Map<string, number>();
    
    // Initialize with all dates in the range set to 0
    let currentDate = new Date(timeRange.startDate);
    while (currentDate <= timeRange.endDate) {
      const dateStr = format(currentDate, 'yyyy-MM-dd');
      dateMap.set(dateStr, 0);
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    // Count conversations per day
    conversationsInRange.forEach(convo => {
      // Earlier filter guarantees createdAt is non-null here
      // We know createdAt exists because of the previous filter
      const createdAt = convo.createdAt as string | number | Date; // Type assertion
      const convoDate = createdAt instanceof Date 
        ? createdAt 
        : new Date(createdAt);
      const dateStr = format(convoDate, 'yyyy-MM-dd');
      if (dateMap.has(dateStr)) {
        dateMap.set(dateStr, (dateMap.get(dateStr) || 0) + 1);
      }
    });
    
    // Convert to array format for storage
    Array.from(dateMap.entries()).forEach(([date, count]) => {
      conversationTrend.push({ date, count });
    });
    
    // Sort by date
    conversationTrend.sort((a, b) => a.date.localeCompare(b.date));
    
    // Get all messages for these conversations
    let totalMessages = 0;
    let responseTimesMs: number[] = [];
    
    for (const convo of conversationsInRange) {
      const messages = await storage.getMessagesByConversation(convo.id);
      totalMessages += messages.length;
      
      // Collect response times for bot messages
      const botResponseTimes = messages
        .filter(msg => msg.sender === 'bot' && msg.responseTime !== null)
        .map(msg => msg.responseTime || 0);
      
      responseTimesMs = [...responseTimesMs, ...botResponseTimes];
    }
    
    // Calculate response time and completion rate
    const averageResponseTime = responseTimesMs.length > 0
      ? responseTimesMs.reduce((sum, time) => sum + time, 0) / responseTimesMs.length / 1000 // convert to seconds
      : 0;
    
    const completionRate = conversationsInRange.length > 0
      ? responseTimesMs.length / conversationsInRange.length
      : 0;
    
    // Get sentiment data
    const sentimentDistribution = await storage.getSentimentDistribution(
      pageId, 
      timeRange.startDate,
      timeRange.endDate
    );
    
    // Ensure we have valid sentiment data
    const validSentimentData = sentimentDistribution || [];
    
    // Log sentiment data for debugging
    console.log(`[Insights] Retrieved sentiment distribution for ${pageId} period ${timeRange.timePeriod}:`, 
      validSentimentData.map((item: any) => `${item.sentiment}:${item.count}`).join(', '));
    
    // Count sentiment distribution
    let sentimentPositive = 0;
    let sentimentNeutral = 0;
    let sentimentNegative = 0;
    
    validSentimentData.forEach((item: {sentiment: string, count: number}) => {
      if (item.sentiment === 'positive') {
        sentimentPositive += item.count;
      } else if (item.sentiment === 'neutral') {
        sentimentNeutral += item.count;
      } else if (item.sentiment === 'negative') {
        sentimentNegative += item.count;
      }
    });
    
    // Create new insight
    const newInsight = await storage.createDashboardInsight({
      pageId,
      date: new Date(),
      timePeriod: timeRange.timePeriod,
      startDate: timeRange.startDate,
      endDate: timeRange.endDate,
      totalConversations: conversationsInRange.length,
      totalMessages,
      averageResponseTime,
      completionRate,
      sentimentPositive,
      sentimentNeutral,
      sentimentNegative,
      averageSentiment: sentimentPositive > sentimentNegative ? 0.7 : 0.3,
      conversationTrend,
      sentimentDistribution: validSentimentData
    });
    
    return newInsight;
  } catch (error) {
    console.error('Error generating insights:', error);
    return null;
  }
}

/**
 * Compare insights between current and previous time periods
 * @param pageId The ID of the Facebook page
 * @param timePeriod The time period to compare ('day', 'week', 'month', 'year')
 * @returns Promise resolving to comparison results
 */
export async function compareInsightsPeriods(pageId: string, timePeriod: string): Promise<InsightComparison> {
  // Get time ranges for current and previous periods
  const ranges = getTimeRanges(timePeriod);
  
  // Get or generate insights for both periods
  const currentInsight = await getOrGenerateInsights(pageId, ranges.current);
  const previousInsight = await getOrGenerateInsights(pageId, ranges.previous);
  
  // Calculate changes between periods
  const calculateChange = (current: number, previous: number) => {
    return {
      value: current - previous,
      percentage: calculatePercentageChange(current, previous)
    };
  };
  
  const changes = {
    totalConversations: calculateChange(
      currentInsight?.totalConversations || 0, 
      previousInsight?.totalConversations || 0
    ),
    totalMessages: calculateChange(
      currentInsight?.totalMessages || 0, 
      previousInsight?.totalMessages || 0
    ),
    averageResponseTime: calculateChange(
      currentInsight?.averageResponseTime || 0, 
      previousInsight?.averageResponseTime || 0
    ),
    completionRate: calculateChange(
      currentInsight?.completionRate || 0, 
      previousInsight?.completionRate || 0
    ),
    sentimentPositive: calculateChange(
      currentInsight?.sentimentPositive || 0, 
      previousInsight?.sentimentPositive || 0
    ),
    sentimentNeutral: calculateChange(
      currentInsight?.sentimentNeutral || 0, 
      previousInsight?.sentimentNeutral || 0
    ),
    sentimentNegative: calculateChange(
      currentInsight?.sentimentNegative || 0, 
      previousInsight?.sentimentNegative || 0
    ),
    averageSentiment: calculateChange(
      currentInsight?.averageSentiment || 0, 
      previousInsight?.averageSentiment || 0
    )
  };
  
  return {
    current: currentInsight,
    previous: previousInsight,
    changes
  };
}

/**
 * Generate and store insights for all time periods
 * @param pageId The ID of the Facebook page
 * @param refresh Optional flag to force regeneration of insights
 * @returns Promise resolving to the generated insights
 */
export async function generateAllPeriodInsights(pageId: string, refresh: boolean = false): Promise<{
  day: DashboardInsight | null;
  week: DashboardInsight | null;
  month: DashboardInsight | null;
  year: DashboardInsight | null;
}> {
  // Generate insights for all time periods
  const periods = ['day', 'week', 'month', 'year'];
  const results: Record<string, DashboardInsight | null> = {};
  
  for (const period of periods) {
    const range = getTimeRanges(period).current;
    results[period] = await getOrGenerateInsights(pageId, range, refresh);
  }
  
  return {
    day: results['day'],
    week: results['week'],
    month: results['month'],
    year: results['year']
  };
}

/**
 * Get insights data for a specific time period and compare with previous period
 * @param pageId The Facebook page ID
 * @param timePeriod The time period to analyze ('day', 'week', 'month', 'year')
 * @returns Promise resolving to the insights with comparison data
 */
export async function getTimeComparisonInsights(pageId: string, timePeriod: string): Promise<InsightComparison> {
  return await compareInsightsPeriods(pageId, timePeriod);
}

/**
 * Refresh insights data for all pages and all time periods
 * This ensures all data is up-to-date in the database
 * @returns Promise that resolves when all data is refreshed
 */
export async function refreshAllInsightsData(): Promise<void> {
  try {
    console.log('[Insights] Starting refresh of all insights data');
    // Get all pages
    const allPages = await storage.getAllPages();
    
    // Time periods to refresh
    const timePeriods = ['day', 'week', 'month', 'year'];
    
    // For each page, refresh all time periods
    for (const page of allPages) {
      console.log(`[Insights] Refreshing insights for page ${page.pageId}`);
      
      for (const period of timePeriods) {
        console.log(`[Insights] Refreshing ${period} period for page ${page.pageId}`);
        
        // Delete existing insights for this page and period
        await storage.deleteDashboardInsight(page.pageId, period);
        
        // Calculate days based on the new period definitions
        let days = 1; // 'day' = Today (1 day)
        if (period === 'week') days = 7; // 'week' = Last 7 Days
        else if (period === 'month') days = 30; // 'month' = Last 30 Days
        else if (period === 'year') {
          // 'year' = Year to Date (from Jan 1 to today)
          const startOfYearDate = startOfYear(new Date());
          const today = new Date();
          days = Math.ceil((today.getTime() - startOfYearDate.getTime()) / (1000 * 60 * 60 * 24));
        }
        
        // Get time ranges for this period
        const timeRange = getTimeRanges(period).current;
        
        // Generate new insights
        await getOrGenerateInsights(page.pageId, timeRange, true);
      }
    }
    
    console.log('[Insights] Successfully refreshed all insights data');
  } catch (error) {
    console.error('[Insights] Error refreshing insights data:', error);
    throw error;
  }
}