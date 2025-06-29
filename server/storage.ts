import {
  User, InsertUser,
  Page, InsertPage,
  PageConfig, InsertPageConfig,
  Conversation, InsertConversation,
  Message, InsertMessage,
  ApiConfig, InsertApiConfig,
  Activity, InsertActivity,
  UserPage, InsertUserPage,
  UserState, InsertUserState,
  DashboardMetrics,
  DashboardInsight, InsertDashboardInsight,
  SentimentDistribution, InsertSentimentDistribution,
  InstagramMapping, InsertInstagramMapping,
  OAuthState, InsertOAuthState,
  // Import the actual schema tables
  users,
  pages,
  conversations,
  messages,
  dashboardInsights,
  sentimentDistribution,
  apiConfigs,
  activities,
  userPages,
  userStates,
  instagramMappings,
  oauthStates
} from "@shared/schema";
import { format, subDays } from "date-fns";

// Storage interface for all data operations
import session from "express-session";
import createMemoryStore from "memorystore";
import connectPg from "connect-pg-simple";
import { db } from "./db";
import { eq, and, desc, gte, lte, sql, count, sum, avg, isNotNull } from "drizzle-orm";
import { pool } from "./db";
import { dbCache } from "./cache";

// Create database session store
const PostgresSessionStore = connectPg(session);

// Create a memory store for session (fallback)
const MemoryStore = createMemoryStore(session);

export interface IStorage {
  // User operations
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Page operations
  getPage(id: number): Promise<Page | undefined>;
  getPageByPageId(pageId: string): Promise<Page | undefined>;
  getPageById(pageId: string): Promise<Page | undefined>;
  getAllPages(): Promise<Page[]>;
  createPage(page: InsertPage): Promise<Page>;

  updatePage(id: number, page: Partial<InsertPage>): Promise<Page | undefined>;
  updatePage(pageId: string, page: Partial<InsertPage>): Promise<Page | undefined>;
  deletePage(id: number): Promise<boolean>;
  
  // User-Page operations (for role-based access control)
  getUserPages(userId: number): Promise<Page[]>;
  getPageUsers(pageId: string): Promise<User[]>;
  assignPageToUser(userId: number, pageId: string): Promise<UserPage>;
  removePageFromUser(userId: number, pageId: string): Promise<boolean>;
  isUserAuthorizedForPage(userId: number, pageId: string): Promise<boolean>;
  
  // Page Configuration operations (using pages.metadata)
  getPageConfig(pageId: string): Promise<PageConfig | undefined>;
  updatePageConfig(pageId: string, data: Partial<InsertPageConfig>): Promise<PageConfig | undefined>;
  
  // Conversation operations
  getConversation(id: number): Promise<Conversation | undefined>;
  getConversationBySenderId(senderId: string, pageId: string): Promise<Conversation | undefined>;
  getConversationsByPageId(pageId: string): Promise<Conversation[]>;
  createConversation(conversation: InsertConversation): Promise<Conversation>;
  updateConversation(id: number, data: Partial<Conversation>): Promise<Conversation | undefined>;
  
  // Message operations
  getMessage(id: number): Promise<Message | undefined>;
  getMessagesByConversation(conversationId: number): Promise<Message[]>;
  createMessage(message: InsertMessage): Promise<Message>;
  
  // API Config operations
  getApiConfig(service: string): Promise<ApiConfig | undefined>;
  getAllApiConfigs(): Promise<ApiConfig[]>;
  createApiConfig(config: InsertApiConfig): Promise<ApiConfig>;
  updateApiConfig(id: number, config: Partial<InsertApiConfig>): Promise<ApiConfig | undefined>;
  
  // Activity operations
  getRecentActivities(limit: number): Promise<Activity[]>;
  createActivity(activity: InsertActivity): Promise<Activity>;
  
  // Dashboard metrics
  getDashboardMetrics(days: number): Promise<DashboardMetrics>;
  
  // User State operations
  getUserState(senderId: string): Promise<UserState | undefined>;
  getAllUserStates(): Promise<UserState[]>;
  getUserStateByConversationId(conversationId: number): Promise<UserState | undefined>;
  getUserStatesByPageId(pageId: string): Promise<UserState[]>;
  createUserState(userState: InsertUserState): Promise<UserState>;
  updateUserState(senderId: string, data: Partial<UserState>): Promise<UserState | undefined>;
  
  // Dashboard Insights operations
  getDashboardInsight(pageId: string, timePeriod: string): Promise<DashboardInsight | undefined>;
  getDashboardInsightById(id: number): Promise<DashboardInsight | undefined>;
  createDashboardInsight(insight: InsertDashboardInsight): Promise<DashboardInsight>;
  updateDashboardInsight(id: number, data: Partial<DashboardInsight>): Promise<DashboardInsight | undefined>;
  deleteDashboardInsight(idOrPageId: number | string, timePeriod?: string): Promise<boolean>;
  getDashboardInsightsForPage(pageId: string): Promise<DashboardInsight[]>;
  
  // Sentiment Distribution operations
  getSentimentDistribution(pageId: string, startDate: Date, endDate: Date): Promise<any>;
  getSentimentDistributionForSender(senderId: string): Promise<SentimentDistribution | undefined>;
  createSentimentDistribution(sentiment: InsertSentimentDistribution): Promise<SentimentDistribution>;
  updateSentimentDistribution(id: number, data: Partial<SentimentDistribution>): Promise<SentimentDistribution | undefined>;
  
  // OAuth state management for reliable user tracking
  saveOAuthState(state: string, userId: number, platform: string): Promise<OAuthState>;
  getOAuthState(state: string): Promise<OAuthState | undefined>;
  deleteOAuthState(state: string): Promise<boolean>;
  cleanupExpiredOAuthStates(): Promise<number>;
  
  // Session store
  sessionStore: session.Store;
}

// In-memory implementation of the storage interface
export class MemStorage implements IStorage {
  private users: Map<number, User>;
  private pages: Map<number, Page>;
  private userPages: Map<number, UserPage>;
  private conversations: Map<number, Conversation>;
  private messages: Map<number, Message>;
  private apiConfigs: Map<number, ApiConfig>;
  private activities: Map<number, Activity>;
  private userStates: Map<number, UserState>;
  private dashboardInsights: Map<number, DashboardInsight>;
  private sentimentDistributions: Map<number, SentimentDistribution>;
  private oauthStates: Map<string, OAuthState>;
  
  // Session store for Express sessions
  public sessionStore: session.Store;
  
  private userId: number;
  private pageId: number;
  private userPageId: number;
  private conversationId: number;
  private messageId: number;
  private apiConfigId: number;
  private activityId: number;
  private userStateId: number;
  private dashboardInsightId: number;
  private sentimentDistributionId: number;
  
  constructor() {
    this.users = new Map();
    this.pages = new Map();
    this.userPages = new Map();
    this.conversations = new Map();
    this.messages = new Map();
    this.apiConfigs = new Map();
    this.activities = new Map();
    this.userStates = new Map();
    this.dashboardInsights = new Map();
    this.sentimentDistributions = new Map();
    this.oauthStates = new Map();
    
    // Initialize the session store
    this.sessionStore = new MemoryStore({
      checkPeriod: 86400000 // prune expired entries every 24h
    });
    
    this.userId = 1;
    this.pageId = 1;
    this.userPageId = 1;
    this.conversationId = 1;
    this.messageId = 1;
    this.apiConfigId = 1;
    this.activityId = 1;
    this.userStateId = 1;
    this.dashboardInsightId = 1;
    this.sentimentDistributionId = 1;
    
    // Initialize with authentic data only - no hardcoded fallbacks
    (async () => {
      try {
        await this.initializeDefaultData();
        console.log("Authentication system initialization completed successfully");
      } catch (error) {
        console.error("Error in authentication system initialization:", error);
      }
    })();
  }
  
  private async initializeDefaultData() {
    // No hardcoded synthetic data initialization
    // System will only use authentic data from authorized OAuth connections
    console.log("Skipping synthetic data initialization - system configured for authentic data only");
  }
  
  // User operations
  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }
  
  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username
    );
  }
  
  async getUserByEmail(email: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.email === email
    );
  }
  
  async createUser(user: InsertUser): Promise<User> {
    const id = this.userId++;
    const createdAt = new Date();
    const newUser: User = { 
      id, 
      username: user.username,
      password: user.password,
      email: user.email,
      role: user.role || 'user',
      isAdmin: user.isAdmin || false,
      createdAt
    };
    this.users.set(id, newUser);
    return newUser;
  }
  
  // Page operations
  async getPage(id: number): Promise<Page | undefined> {
    return this.pages.get(id);
  }
  
  async getPageByPageId(pageId: string): Promise<Page | undefined> {
    return Array.from(this.pages.values()).find(
      (page) => page.pageId === pageId
    );
  }
  
  async getPageById(pageId: string): Promise<Page | undefined> {
    return this.getPageByPageId(pageId);
  }
  
  async getAllPages(): Promise<Page[]> {
    return Array.from(this.pages.values());
  }
  
  async createPage(page: InsertPage): Promise<Page> {
    const id = this.pageId++;
    const createdAt = new Date();
    const newPage: Page = { 
      id,
      name: page.name,
      pageId: page.pageId,
      accessToken: page.accessToken,
      status: page.status || 'active',
      platform: page.platform || 'Facebook',
      assistantId: page.assistantId || null,
      metadata: page.metadata || {},
      createdAt: createdAt
    };
    this.pages.set(id, newPage);
    return newPage;
  }
  
  async updatePage(idOrPageId: number | string, data: Partial<InsertPage>): Promise<Page | undefined> {
    let page: Page | undefined;
    
    if (typeof idOrPageId === 'number') {
      page = this.pages.get(idOrPageId);
    } else {
      page = Array.from(this.pages.values()).find(p => p.pageId === idOrPageId);
    }
    
    if (!page) return undefined;
    
    const updatedPage: Page = { ...page, ...data };
    this.pages.set(page.id, updatedPage);
    return updatedPage;
  }
  
  async deletePage(id: number): Promise<boolean> {
    return this.pages.delete(id);
  }
  
  // User-Page operations
  async getUserPages(userId: number): Promise<Page[]> {
    const userPageEntries = Array.from(this.userPages.values()).filter(
      (userPage) => userPage.userId === userId
    );
    
    const pages: Page[] = [];
    for (const userPage of userPageEntries) {
      const page = await this.getPageByPageId(userPage.pageId);
      if (page) {
        pages.push(page);
      }
    }
    return pages;
  }
  
  async getPageUsers(pageId: string): Promise<User[]> {
    const userPageEntries = Array.from(this.userPages.values()).filter(
      (userPage) => userPage.pageId === pageId
    );
    
    return userPageEntries
      .map((userPage) => this.users.get(userPage.userId))
      .filter((user): user is User => user !== undefined);
  }
  
  async assignPageToUser(userId: number, pageId: string): Promise<UserPage> {
    const id = this.userPageId++;
    const userPage: UserPage = {
      id,
      userId,
      pageId,
      createdAt: new Date()
    };
    this.userPages.set(id, userPage);
    return userPage;
  }
  
  async removePageFromUser(userId: number, pageId: string): Promise<boolean> {
    const userPageEntry = Array.from(this.userPages.entries()).find(
      ([, userPage]) => userPage.userId === userId && userPage.pageId === pageId
    );
    
    if (userPageEntry) {
      this.userPages.delete(userPageEntry[0]);
      return true;
    }
    
    return false;
  }
  
  async isUserAuthorizedForPage(userId: number, pageId: string): Promise<boolean> {
    // Check if user is admin
    const user = await this.getUser(userId);
    if (user?.isAdmin) return true;
    
    // Check explicit page assignment
    return Array.from(this.userPages.values()).some(
      (userPage) => userPage.userId === userId && userPage.pageId === pageId
    );
  }
  
  // Page Configuration operations (using pages.metadata)
  async getPageConfig(pageId: string): Promise<PageConfig | undefined> {
    const page = await this.getPageByPageId(pageId);
    if (!page) return undefined;
    
    const metadata = (page.metadata as any) || {};
    return {
      pageId: page.pageId,
      greetingMessage: metadata.greetingMessage || "",
      firstMessage: metadata.firstMessage || "",
      maxMessages: metadata.maxMessages || 10,
      endMessage: metadata.endMessage || "",
      stopMessage: metadata.stopMessage || ""
    };
  }
  
  async updatePageConfig(pageId: string, data: Partial<InsertPageConfig>): Promise<PageConfig | undefined> {
    const page = await this.getPageByPageId(pageId);
    if (!page) return undefined;
    
    const currentMetadata = (page.metadata as any) || {};
    const updatedMetadata = {
      ...currentMetadata,
      greetingMessage: data.greetingMessage !== undefined ? data.greetingMessage : currentMetadata.greetingMessage,
      firstMessage: data.firstMessage !== undefined ? data.firstMessage : currentMetadata.firstMessage,
      maxMessages: data.maxMessages !== undefined ? data.maxMessages : currentMetadata.maxMessages,
      endMessage: data.endMessage !== undefined ? data.endMessage : currentMetadata.endMessage,
      stopMessage: data.stopMessage !== undefined ? data.stopMessage : currentMetadata.stopMessage,
    };
    
    const updatedPage = await this.updatePage(page.id, { metadata: updatedMetadata });
    if (!updatedPage) return undefined;
    
    return {
      pageId: updatedPage.pageId,
      greetingMessage: updatedMetadata.greetingMessage || "",
      firstMessage: updatedMetadata.firstMessage || "",
      maxMessages: updatedMetadata.maxMessages || 10,
      endMessage: updatedMetadata.endMessage || "",
      stopMessage: updatedMetadata.stopMessage || ""
    };
  }
  
  // Conversation operations
  async getConversation(id: number): Promise<Conversation | undefined> {
    return this.conversations.get(id);
  }
  
  async getConversationBySenderId(senderId: string, pageId: string): Promise<Conversation | undefined> {
    return Array.from(this.conversations.values()).find(
      (conversation) => conversation.senderId === senderId && conversation.pageId === pageId
    );
  }
  
  async getConversationsByPageId(pageId: string): Promise<Conversation[]> {
    return Array.from(this.conversations.values()).filter(
      (conversation) => conversation.pageId === pageId
    );
  }
  
  async createConversation(conversation: InsertConversation): Promise<Conversation> {
    const id = this.conversationId++;
    const createdAt = new Date();
    const newConversation: Conversation = { 
      ...conversation, 
      id, 
      createdAt,
      lastMessageAt: createdAt,
      messageCount: 0,
      status: conversation.status || "active"
    };
    this.conversations.set(id, newConversation);
    return newConversation;
  }
  
  async updateConversation(id: number, data: Partial<Conversation>): Promise<Conversation | undefined> {
    const conversation = this.conversations.get(id);
    if (!conversation) return undefined;
    
    const updatedConversation: Conversation = { ...conversation, ...data };
    this.conversations.set(id, updatedConversation);
    return updatedConversation;
  }
  
  // Message operations
  async getMessage(id: number): Promise<Message | undefined> {
    return this.messages.get(id);
  }
  
  async getMessagesByConversation(conversationId: number): Promise<Message[]> {
    return Array.from(this.messages.values()).filter(
      (message) => message.conversationId === conversationId
    );
  }
  
  async createMessage(message: InsertMessage): Promise<Message> {
    const id = this.messageId++;
    const sentAt = new Date();
    const newMessage: Message = { 
      ...message, 
      id, 
      sentAt,
      responseTime: message.responseTime || null
    };
    this.messages.set(id, newMessage);
    return newMessage;
  }
  
  // API Config operations
  async getApiConfig(service: string): Promise<ApiConfig | undefined> {
    return Array.from(this.apiConfigs.values()).find(
      (config) => config.service === service
    );
  }
  
  async getAllApiConfigs(): Promise<ApiConfig[]> {
    return Array.from(this.apiConfigs.values());
  }
  
  async createApiConfig(config: InsertApiConfig): Promise<ApiConfig> {
    const id = this.apiConfigId++;
    const newConfig: ApiConfig = { 
      ...config, 
      id,
      lastCheckedAt: null,
      metadata: config.metadata || null
    };
    this.apiConfigs.set(id, newConfig);
    return newConfig;
  }
  
  async updateApiConfig(id: number, data: Partial<InsertApiConfig>): Promise<ApiConfig | undefined> {
    const config = this.apiConfigs.get(id);
    if (!config) return undefined;
    
    const updatedAt = new Date();
    const updatedConfig: ApiConfig = { ...config, ...data, updatedAt };
    this.apiConfigs.set(id, updatedConfig);
    return updatedConfig;
  }
  
  // Activity operations
  async getRecentActivities(limit: number): Promise<Activity[]> {
    return Array.from(this.activities.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
  
  async createActivity(activity: InsertActivity): Promise<Activity> {
    const id = this.activityId++;
    const createdAt = new Date();
    const newActivity: Activity = { ...activity, id, createdAt };
    this.activities.set(id, newActivity);
    return newActivity;
  }
  
  // User State operations
  async getUserState(senderId: string): Promise<UserState | undefined> {
    return Array.from(this.userStates.values()).find(
      (state) => state.senderId === senderId
    );
  }

  async getAllUserStates(): Promise<UserState[]> {
    return Array.from(this.userStates.values());
  }
  
  async getUserStateByConversationId(conversationId: number): Promise<UserState | undefined> {
    return Array.from(this.userStates.values()).find(
      (state) => state.conversationId === conversationId
    );
  }
  
  async getUserStatesByPageId(pageId: string): Promise<UserState[]> {
    return Array.from(this.userStates.values()).filter(
      (state) => state.pageId === pageId
    );
  }
  
  async createUserState(userState: InsertUserState): Promise<UserState> {
    const id = this.userStateId++;
    const createdAt = new Date();
    const newUserState: UserState = { 
      ...userState, 
      id, 
      createdAt,
      updatedAt: createdAt,
      lastMessageTime: userState.lastMessageTime || createdAt,
      messageCount: userState.messageCount || 0,
      labels: userState.labels || [],
      conversationId: userState.conversationId || null,
      threadId: userState.threadId || null,
      runId: userState.runId || null,
      isNewUser: userState.isNewUser || false,
      hasStopMessage: userState.hasStopMessage || false,
      lastMessage: userState.lastMessage || null,
      rank: userState.rank || null,
      messagesContext: userState.messagesContext || [],
      conversation: userState.conversation || []
    };
    this.userStates.set(id, newUserState);
    return newUserState;
  }
  
  async updateUserState(senderId: string, data: Partial<UserState>): Promise<UserState | undefined> {
    const stateEntry = Array.from(this.userStates.entries()).find(
      ([, state]) => state.senderId === senderId
    );
    
    if (!stateEntry) return undefined;
    
    const [id, state] = stateEntry;
    const updatedAt = new Date();
    const updatedState: UserState = { ...state, ...data, updatedAt };
    this.userStates.set(id, updatedState);
    return updatedState;
  }
  
  // Dashboard metrics
  async getDashboardMetrics(days: number = 7): Promise<DashboardMetrics> {
    const startDate = subDays(new Date(), days);
    
    // Calculate metrics from stored data
    const recentConversations = Array.from(this.conversations.values()).filter(
      (conv) => conv.createdAt >= startDate
    );
    
    const recentMessages = Array.from(this.messages.values()).filter(
      (msg) => msg.sentAt >= startDate
    );
    
    const totalConversations = recentConversations.length;
    const totalMessages = recentMessages.length;
    
    // Calculate response times for bot messages only
    const botMessages = recentMessages.filter(msg => msg.sender === "bot" && msg.responseTime);
    const avgResponseTime = botMessages.length > 0 
      ? Math.round(botMessages.reduce((sum, msg) => sum + (msg.responseTime || 0), 0) / botMessages.length)
      : 0;
    
    // Generate conversation trend (simplified)
    const conversationTrend = Array.from({ length: days }, (_, i) => {
      const day = subDays(new Date(), days - 1 - i);
      const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      
      const count = recentConversations.filter(
        conv => conv.createdAt >= dayStart && conv.createdAt < dayEnd
      ).length;
      
      return {
        date: format(day, "MMM dd"),
        conversations: count
      };
    });
    
    // Generate sentiment distribution (mock data since we don't have sentiment analysis yet)
    const sentimentDistribution = [
      { sentiment: "positive", count: Math.floor(totalMessages * 0.6), percentage: 60 },
      { sentiment: "neutral", count: Math.floor(totalMessages * 0.3), percentage: 30 },
      { sentiment: "negative", count: Math.floor(totalMessages * 0.1), percentage: 10 }
    ];
    
    return {
      totalConversations,
      totalMessages,
      avgResponseTime,
      conversationTrend,
      sentimentDistribution
    };
  }
  
  private getSentimentLabel(rank: number): string {
    if (rank >= 0.6) return "positive";
    if (rank >= 0.4) return "neutral";
    return "negative";
  }
  
  // Dashboard Insights operations
  async getDashboardInsight(pageId: string, timePeriod: string): Promise<DashboardInsight | undefined> {
    return Array.from(this.dashboardInsights.values()).find(
      (insight) => insight.pageId === pageId && insight.timePeriod === timePeriod
    );
  }
  
  async getDashboardInsightById(id: number): Promise<DashboardInsight | undefined> {
    return this.dashboardInsights.get(id);
  }
  
  async createDashboardInsight(insight: InsertDashboardInsight): Promise<DashboardInsight> {
    const id = this.dashboardInsightId++;
    const createdAt = new Date();
    const newInsight: DashboardInsight = { 
      ...insight, 
      id, 
      createdAt,
      updatedAt: createdAt 
    };
    this.dashboardInsights.set(id, newInsight);
    return newInsight;
  }
  
  async updateDashboardInsight(id: number, data: Partial<DashboardInsight>): Promise<DashboardInsight | undefined> {
    const insight = this.dashboardInsights.get(id);
    if (!insight) return undefined;
    
    const updatedAt = new Date();
    const updatedInsight: DashboardInsight = { ...insight, ...data, updatedAt };
    this.dashboardInsights.set(id, updatedInsight);
    return updatedInsight;
  }
  
  async deleteDashboardInsight(idOrPageId: number | string, timePeriod?: string): Promise<boolean> {
    if (typeof idOrPageId === 'number') {
      return this.dashboardInsights.delete(idOrPageId);
    } else {
      const insightEntry = Array.from(this.dashboardInsights.entries()).find(
        ([, insight]) => insight.pageId === idOrPageId && (!timePeriod || insight.timePeriod === timePeriod)
      );
      
      if (insightEntry) {
        this.dashboardInsights.delete(insightEntry[0]);
        return true;
      }
      
      return false;
    }
  }
  
  async getDashboardInsightsForPage(pageId: string): Promise<DashboardInsight[]> {
    return Array.from(this.dashboardInsights.values()).filter(
      (insight) => insight.pageId === pageId
    );
  }
  
  // Sentiment Distribution operations
  async getSentimentDistribution(pageId: string, startDate: Date, endDate: Date): Promise<any> {
    try {
      // Get conversations for the page within the date range from memory
      const conversationsForPage = Array.from(this.conversations.values())
        .filter(conv => 
          conv.pageId === pageId && 
          conv.createdAt && 
          conv.createdAt >= startDate && 
          conv.createdAt <= endDate
        );

      if (!conversationsForPage.length) {
        return [
          { sentiment: "positive", count: 0, percentage: 0 },
          { sentiment: "neutral", count: 0, percentage: 0 },
          { sentiment: "negative", count: 0, percentage: 0 }
        ];
      }

      // Count sentiment distribution based on user states rank
      let positive = 0, neutral = 0, negative = 0;
      
      for (const conv of conversationsForPage) {
        const userState = await this.getUserState(conv.senderId);
        if (userState && userState.rank !== null) {
          if (userState.rank >= 0.6) positive++;
          else if (userState.rank >= 0.4) neutral++;
          else negative++;
        } else {
          // Default to neutral if no sentiment data
          neutral++;
        }
      }

      const total = positive + neutral + negative;
      return [
        { sentiment: "positive", count: positive, percentage: total > 0 ? Math.round((positive/total) * 100) : 0 },
        { sentiment: "neutral", count: neutral, percentage: total > 0 ? Math.round((neutral/total) * 100) : 0 },
        { sentiment: "negative", count: negative, percentage: total > 0 ? Math.round((negative/total) * 100) : 0 }
      ];
    } catch (error) {
      console.error('Error getting sentiment distribution:', error);
      return [
        { sentiment: "positive", count: 0, percentage: 0 },
        { sentiment: "neutral", count: 0, percentage: 0 },
        { sentiment: "negative", count: 0, percentage: 0 }
      ];
    }
  }
  
  async getSentimentDistributionForSender(senderId: string): Promise<SentimentDistribution | undefined> {
    return Array.from(this.sentimentDistributions.values()).find(
      (sentiment) => sentiment.senderId === senderId
    );
  }
  
  async createSentimentDistribution(sentiment: InsertSentimentDistribution): Promise<SentimentDistribution> {
    const id = this.sentimentDistributionId++;
    const createdAt = new Date();
    const newSentiment: SentimentDistribution = {
      ...sentiment,
      id,
      createdAt,
      updatedAt: createdAt
    };
    this.sentimentDistributions.set(id, newSentiment);
    return newSentiment;
  }
  
  async updateSentimentDistribution(id: number, data: Partial<SentimentDistribution>): Promise<SentimentDistribution | undefined> {
    const sentiment = this.sentimentDistributions.get(id);
    if (!sentiment) return undefined;
    
    const updatedAt = new Date();
    const updatedSentiment: SentimentDistribution = { ...sentiment, ...data, updatedAt };
    this.sentimentDistributions.set(id, updatedSentiment);
    return updatedSentiment;
  }

  // OAuth state management operations
  async saveOAuthState(state: string, userId: number, platform: string): Promise<OAuthState> {
    const createdAt = new Date();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    
    const oauthState: OAuthState = {
      state,
      userId,
      platform,
      createdAt,
      expiresAt
    };
    
    this.oauthStates.set(state, oauthState);
    return oauthState;
  }
  
  async getOAuthState(state: string): Promise<OAuthState | undefined> {
    const oauthState = this.oauthStates.get(state);
    
    // Check if expired
    if (oauthState && oauthState.expiresAt < new Date()) {
      this.oauthStates.delete(state);
      return undefined;
    }
    
    return oauthState;
  }
  
  async deleteOAuthState(state: string): Promise<boolean> {
    return this.oauthStates.delete(state);
  }
  
  async cleanupExpiredOAuthStates(): Promise<number> {
    const now = new Date();
    let cleanupCount = 0;
    
    for (const [state, oauthState] of this.oauthStates.entries()) {
      if (oauthState.expiresAt < now) {
        this.oauthStates.delete(state);
        cleanupCount++;
      }
    }
    
    return cleanupCount;
  }
}

// Database implementation of the storage interface
export class DatabaseStorage implements IStorage {
  // Session store for Express sessions
  public sessionStore: session.Store;

  constructor() {
    // Use memory store for sessions to avoid connection pool compatibility issues
    const MemoryStore = createMemoryStore(session);
    this.sessionStore = new MemoryStore({
      checkPeriod: 86400000 // prune expired entries every 24h
    });
  }

  // User operations
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async createUser(user: InsertUser): Promise<User> {
    const [newUser] = await db.insert(users).values(user).returning();
    return newUser;
  }

  // Page operations
  async getPage(id: number): Promise<Page | undefined> {
    const [page] = await db.select().from(pages).where(eq(pages.id, id));
    return page;
  }

  async getPageByPageId(pageId: string): Promise<Page | undefined> {
    const [page] = await db.select().from(pages).where(eq(pages.pageId, pageId));
    return page;
  }

  async getPageById(pageId: string): Promise<Page | undefined> {
    return this.getPageByPageId(pageId);
  }

  async getAllPages(): Promise<Page[]> {
    const result = await db.select().from(pages);
    return result.map(page => ({
      ...page,
      metadata: page.metadata || null
    }));
  }

  async createPage(page: InsertPage): Promise<Page> {
    const [newPage] = await db.insert(pages).values(page).returning();
    return newPage;
  }

  async updatePage(idOrPageId: number | string, data: Partial<InsertPage>): Promise<Page | undefined> {
    let result;
    
    if (typeof idOrPageId === 'number') {
      [result] = await db.update(pages)
        .set(data)
        .where(eq(pages.id, idOrPageId))
        .returning();
    } else {
      [result] = await db.update(pages)
        .set(data)
        .where(eq(pages.pageId, idOrPageId))
        .returning();
    }
    
    return result;
  }

  async deletePage(id: number): Promise<boolean> {
    try {
      // Get the page first to get its pageId
      const page = await this.getPage(id);
      if (!page) {
        return false;
      }

      // Start a transaction to ensure data consistency
      await db.transaction(async (tx) => {
        // 1. Delete related user-page assignments
        await tx.delete(userPages).where(eq(userPages.pageId, page.pageId));
        
        // 2. Page configurations are now stored in pages.metadata - no separate deletion needed
        
        // 3. Delete conversations and their messages for this page
        const conversationsToDelete = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.pageId, page.pageId));
        
        for (const conv of conversationsToDelete) {
          await tx.delete(messages).where(eq(messages.conversationId, conv.id));
        }
        
        await tx.delete(conversations).where(eq(conversations.pageId, page.pageId));
        
        // 4. Delete dashboard insights for this page
        await tx.delete(dashboardInsights).where(eq(dashboardInsights.pageId, page.pageId));
        
        // 5. Delete sentiment distribution data for this page
        await tx.delete(sentimentDistribution).where(eq(sentimentDistribution.pageId, page.pageId));
        
        // 6. Finally delete the page itself
        await tx.delete(pages).where(eq(pages.id, id));
      });
      
      return true;
    } catch (error) {
      console.error("Error deleting page:", error);
      return false;
    }
  }

  // User-Page operations
  async getUserPages(userId: number): Promise<Page[]> {
    const result = await db
      .select({
        id: pages.id,
        pageId: pages.pageId,
        name: pages.name,
        platform: pages.platform,
        accessToken: pages.accessToken,
        status: pages.status,
        assistantId: pages.assistantId,
        createdAt: pages.createdAt
      })
      .from(userPages)
      .innerJoin(pages, eq(userPages.pageId, pages.pageId))
      .where(eq(userPages.userId, userId));
    
    return result.map(page => ({
      ...page,
      metadata: null
    }));
  }

  async getPageUsers(pageId: string): Promise<User[]> {
    const result = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        role: users.role,
        isAdmin: users.isAdmin,
        createdAt: users.createdAt
      })
      .from(userPages)
      .innerJoin(users, eq(userPages.userId, users.id))
      .where(eq(userPages.pageId, pageId));
    
    return result.map(user => ({
      ...user,
      password: '' // Don't expose password
    }));
  }

  async assignPageToUser(userId: number, pageId: string): Promise<UserPage> {
    const [userPage] = await db.insert(userPages).values({
      userId,
      pageId
    }).returning();
    return userPage;
  }

  async removePageFromUser(userId: number, pageId: string): Promise<boolean> {
    const result = await db.delete(userPages)
      .where(and(
        eq(userPages.userId, userId),
        eq(userPages.pageId, pageId)
      ));
    return result.count > 0;
  }

  async isUserAuthorizedForPage(userId: number, pageId: string): Promise<boolean> {
    // Check if user is admin
    const user = await this.getUser(userId);
    if (user?.isAdmin) return true;
    
    // Check explicit page assignment
    const [assignment] = await db
      .select()
      .from(userPages)
      .where(and(
        eq(userPages.userId, userId),
        eq(userPages.pageId, pageId)
      ));
    
    return !!assignment;
  }

  // Page Configuration operations (unified with pages.metadata)
  async getPageConfig(pageId: string): Promise<PageConfig | undefined> {
    const page = await this.getPageByPageId(pageId);
    if (!page) return undefined;
    
    const metadata = (page.metadata as any) || {};
    return {
      pageId,
      greetingMessage: metadata.greetingMessage || "",
      firstMessage: metadata.firstMessage || "",
      maxMessages: metadata.maxMessages || 10,
      endMessage: metadata.endMessage || "",
      stopMessage: metadata.stopMessage || ""
    };
  }

  async createPageConfig(config: InsertPageConfig): Promise<PageConfig> {
    // Create or update page metadata with config values
    const metadata = {
      greetingMessage: config.greetingMessage || "",
      firstMessage: config.firstMessage || "",
      maxMessages: config.maxMessages || 10,
      endMessage: config.endMessage || "",
      stopMessage: config.stopMessage || ""
    };
    
    await this.updatePage(config.pageId, { metadata });
    
    return {
      pageId: config.pageId,
      ...metadata
    };
  }

  async updatePageConfig(pageId: string, data: Partial<InsertPageConfig>): Promise<PageConfig | undefined> {
    const page = await this.getPageByPageId(pageId);
    if (!page) return undefined;
    
    const existingMetadata = (page.metadata as any) || {};
    const updatedMetadata = {
      ...existingMetadata,
      ...Object.fromEntries(
        Object.entries(data).filter(([key]) => key !== 'pageId')
      )
    };
    
    await this.updatePage(pageId, { metadata: updatedMetadata });
    
    return {
      pageId,
      greetingMessage: updatedMetadata.greetingMessage || "",
      firstMessage: updatedMetadata.firstMessage || "",
      maxMessages: updatedMetadata.maxMessages || 10,
      endMessage: updatedMetadata.endMessage || "",
      stopMessage: updatedMetadata.stopMessage || ""
    };
  }

  async deletePageConfig(pageId: string): Promise<boolean> {
    // Remove config-related fields from page metadata
    const page = await this.getPageByPageId(pageId);
    if (!page) return false;
    
    const metadata = (page.metadata as any) || {};
    delete metadata.greetingMessage;
    delete metadata.firstMessage;
    delete metadata.maxMessages;
    delete metadata.endMessage;
    delete metadata.stopMessage;
    
    await this.updatePage(pageId, { metadata });
    return true;
  }

  // Conversation operations
  async getConversation(id: number): Promise<Conversation | undefined> {
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, id));
    return conversation;
  }

  async getConversationBySenderId(senderId: string, pageId: string): Promise<Conversation | undefined> {
    const [conversation] = await db.select().from(conversations)
      .where(and(
        eq(conversations.senderId, senderId),
        eq(conversations.pageId, pageId)
      ));
    return conversation;
  }

  async getConversationsByPageId(pageId: string): Promise<Conversation[]> {
    return await db.select().from(conversations).where(eq(conversations.pageId, pageId));
  }

  async createConversation(conversation: InsertConversation): Promise<Conversation> {
    const [newConversation] = await db.insert(conversations).values({
      ...conversation,
      lastActivity: new Date()
    }).returning();
    return newConversation;
  }

  async updateConversation(id: number, data: Partial<Conversation>): Promise<Conversation | undefined> {
    const [updatedConversation] = await db.update(conversations)
      .set(data)
      .where(eq(conversations.id, id))
      .returning();
    return updatedConversation;
  }

  // Message operations
  async getMessage(id: number): Promise<Message | undefined> {
    const [message] = await db.select().from(messages).where(eq(messages.id, id));
    return message;
  }

  async getMessagesByConversation(conversationId: number): Promise<Message[]> {
    return await db.select().from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.sentAt));
  }

  async createMessage(message: InsertMessage): Promise<Message> {
    const [newMessage] = await db.insert(messages).values(message).returning();
    return newMessage;
  }

  // API Config operations
  async getApiConfig(service: string): Promise<ApiConfig | undefined> {
    const [config] = await db.select().from(apiConfigs).where(eq(apiConfigs.service, service));
    return config;
  }

  async getAllApiConfigs(): Promise<ApiConfig[]> {
    return await db.select().from(apiConfigs);
  }

  async createApiConfig(config: InsertApiConfig): Promise<ApiConfig> {
    const [newConfig] = await db.insert(apiConfigs).values(config).returning();
    return newConfig;
  }

  async updateApiConfig(id: number, config: Partial<InsertApiConfig>): Promise<ApiConfig | undefined> {
    const [updatedConfig] = await db.update(apiConfigs)
      .set({ ...config, updatedAt: new Date() })
      .where(eq(apiConfigs.id, id))
      .returning();
    return updatedConfig;
  }

  // Activity operations
  async getRecentActivities(limit: number): Promise<Activity[]> {
    return await db.select().from(activities)
      .orderBy(desc(activities.createdAt))
      .limit(limit);
  }

  async createActivity(activity: InsertActivity): Promise<Activity> {
    const [newActivity] = await db.insert(activities).values(activity).returning();
    return newActivity;
  }

  // User State operations
  async getUserState(senderId: string): Promise<UserState | undefined> {
    const [state] = await db.select().from(userStates).where(eq(userStates.senderId, senderId));
    return state;
  }

  async getAllUserStates(): Promise<UserState[]> {
    const states = await db.select().from(userStates);
    return states;
  }

  async getUserStateByConversationId(conversationId: number): Promise<UserState | undefined> {
    const [state] = await db.select().from(userStates)
      .where(eq(userStates.conversationId, conversationId));
    return state;
  }

  async getUserStatesByPageId(pageId: string): Promise<UserState[]> {
    return await db.select().from(userStates).where(eq(userStates.pageId, pageId));
  }

  async createUserState(userState: InsertUserState): Promise<UserState> {
    const [newUserState] = await db.insert(userStates).values(userState).returning();
    return newUserState;
  }

  async updateUserState(senderId: string, data: Partial<UserState>): Promise<UserState | undefined> {
    const [updatedState] = await db.update(userStates)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(userStates.senderId, senderId))
      .returning();
    return updatedState;
  }

  // Dashboard metrics
  async getDashboardMetrics(days: number = 7): Promise<DashboardMetrics> {
    const startDate = subDays(new Date(), days);
    
    // Get total conversations in the date range
    const totalConversationsResult = await db
      .select({ count: count() })
      .from(conversations)
      .where(gte(conversations.createdAt, startDate));
    
    const totalConversations = totalConversationsResult[0]?.count || 0;
    
    // Get total messages in the date range
    const totalMessagesResult = await db
      .select({ count: count() })
      .from(messages)
      .where(gte(messages.sentAt, startDate));
    
    const totalMessages = totalMessagesResult[0]?.count || 0;
    
    // Calculate average response time for bot messages
    const avgResponseTimeResult = await db
      .select({ avg: avg(messages.responseTime) })
      .from(messages)
      .where(and(
        gte(messages.sentAt, startDate),
        eq(messages.sender, "bot"),
        isNotNull(messages.responseTime)
      ));
    
    const avgResponseTime = Math.round(Number(avgResponseTimeResult[0]?.avg) || 0);
    
    // Generate conversation trend data
    const conversationTrend = [];
    for (let i = 0; i < days; i++) {
      const day = subDays(new Date(), days - 1 - i);
      const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      
      const dayConversationsResult = await db
        .select({ count: count() })
        .from(conversations)
        .where(and(
          gte(conversations.createdAt, dayStart),
          lte(conversations.createdAt, dayEnd)
        ));
      
      conversationTrend.push({
        date: format(day, "MMM dd"),
        conversations: dayConversationsResult[0]?.count || 0
      });
    }
    
    // Generate sentiment distribution (mock data for now)
    const sentimentDistribution = [
      { sentiment: "positive", count: Math.floor(totalMessages * 0.6), percentage: 60 },
      { sentiment: "neutral", count: Math.floor(totalMessages * 0.3), percentage: 30 },
      { sentiment: "negative", count: Math.floor(totalMessages * 0.1), percentage: 10 }
    ];
    
    return {
      totalConversations,
      totalMessages,
      avgResponseTime,
      conversationTrend,
      sentimentDistribution
    };
  }
  
  private getSentimentLabel(rank: number): string {
    if (rank >= 0.6) return "positive";
    if (rank >= 0.4) return "neutral";
    return "negative";
  }

  // Dashboard Insights operations
  async getDashboardInsight(pageId: string, timePeriod: string): Promise<DashboardInsight | undefined> {
    const [insight] = await db.select().from(dashboardInsights)
      .where(and(
        eq(dashboardInsights.pageId, pageId),
        eq(dashboardInsights.timePeriod, timePeriod)
      ));
    return insight;
  }

  async getDashboardInsightById(id: number): Promise<DashboardInsight | undefined> {
    const [insight] = await db.select().from(dashboardInsights).where(eq(dashboardInsights.id, id));
    return insight;
  }

  async createDashboardInsight(insight: InsertDashboardInsight): Promise<DashboardInsight> {
    const [newInsight] = await db.insert(dashboardInsights).values(insight).returning();
    return newInsight;
  }

  async updateDashboardInsight(id: number, data: Partial<DashboardInsight>): Promise<DashboardInsight | undefined> {
    const [updatedInsight] = await db.update(dashboardInsights)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(dashboardInsights.id, id))
      .returning();
    return updatedInsight;
  }

  async deleteDashboardInsight(idOrPageId: number | string, timePeriod?: string): Promise<boolean> {
    let result;
    
    if (typeof idOrPageId === 'number') {
      result = await db.delete(dashboardInsights).where(eq(dashboardInsights.id, idOrPageId));
    } else {
      if (timePeriod) {
        result = await db.delete(dashboardInsights)
          .where(and(
            eq(dashboardInsights.pageId, idOrPageId),
            eq(dashboardInsights.timePeriod, timePeriod)
          ));
      } else {
        result = await db.delete(dashboardInsights)
          .where(eq(dashboardInsights.pageId, idOrPageId));
      }
    }
    
    return result.count > 0;
  }

  async getDashboardInsightsForPage(pageId: string): Promise<DashboardInsight[]> {
    return await db.select().from(dashboardInsights).where(eq(dashboardInsights.pageId, pageId));
  }

  // Sentiment Distribution operations
  async getSentimentDistribution(pageId: string, startDate: Date, endDate: Date): Promise<any> {
    try {
      console.log(`[DatabaseStorage] Getting authentic sentiment data for page ${pageId} from ${startDate.toISOString()} to ${endDate.toISOString()}`);
      
      // Get actual conversations for the page within the date range from database
      const conversationsForPage = await db.select().from(conversations)
        .where(and(
          eq(conversations.pageId, pageId),
          gte(conversations.createdAt, startDate),
          lte(conversations.createdAt, endDate)
        ));

      console.log(`[DatabaseStorage] Found ${conversationsForPage.length} authentic conversations in database`);

      if (!conversationsForPage.length) {
        console.log(`[DatabaseStorage] No conversations found, returning zero sentiment data`);
        return [
          { sentiment: "positive", count: 0, percentage: 0 },
          { sentiment: "neutral", count: 0, percentage: 0 },
          { sentiment: "negative", count: 0, percentage: 0 }
        ];
      }

      // Count sentiment distribution based on actual user states from database
      let positive = 0, neutral = 0, negative = 0;
      
      for (const conv of conversationsForPage) {
        const userState = await this.getUserState(conv.senderId);
        if (userState && userState.rank !== null) {
          console.log(`[DatabaseStorage] User ${conv.senderId} has rank ${userState.rank}`);
          if (userState.rank >= 0.6) positive++;
          else if (userState.rank >= 0.4) neutral++;
          else negative++;
        } else {
          console.log(`[DatabaseStorage] User ${conv.senderId} has no sentiment data, defaulting to neutral`);
          neutral++;
        }
      }

      const total = positive + neutral + negative;
      console.log(`[DatabaseStorage] Authentic sentiment totals: positive=${positive}, neutral=${neutral}, negative=${negative}, total=${total}`);
      
      return [
        { sentiment: "positive", count: positive, percentage: total > 0 ? Math.round((positive/total) * 100) : 0 },
        { sentiment: "neutral", count: neutral, percentage: total > 0 ? Math.round((neutral/total) * 100) : 0 },
        { sentiment: "negative", count: negative, percentage: total > 0 ? Math.round((negative/total) * 100) : 0 }
      ];
    } catch (error) {
      console.error('Error getting authentic sentiment distribution:', error);
      return [
        { sentiment: "positive", count: 0, percentage: 0 },
        { sentiment: "neutral", count: 0, percentage: 0 },
        { sentiment: "negative", count: 0, percentage: 0 }
      ];
    }
  }

  async getSentimentDistributionForSender(senderId: string): Promise<SentimentDistribution | undefined> {
    const [sentiment] = await db.select().from(sentimentDistribution)
      .where(eq(sentimentDistribution.senderId, senderId));
    return sentiment;
  }

  async createSentimentDistribution(sentiment: InsertSentimentDistribution): Promise<SentimentDistribution> {
    const [newSentiment] = await db.insert(sentimentDistribution).values(sentiment).returning();
    return newSentiment;
  }

  async updateSentimentDistribution(id: number, data: Partial<SentimentDistribution>): Promise<SentimentDistribution | undefined> {
    const [updatedSentiment] = await db.update(sentimentDistribution)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(sentimentDistribution.id, id))
      .returning();
    return updatedSentiment;
  }

  // Instagram mapping operations
  async getInstagramMapping(instagramId: string): Promise<InstagramMapping | undefined> {
    const [mapping] = await db.select().from(instagramMappings)
      .where(eq(instagramMappings.instagramId, instagramId));
    return mapping;
  }

  async getAllInstagramMappings(): Promise<InstagramMapping[]> {
    return await db.select().from(instagramMappings);
  }

  async createInstagramMapping(mapping: InsertInstagramMapping): Promise<InstagramMapping> {
    const [newMapping] = await db.insert(instagramMappings).values(mapping).returning();
    return newMapping;
  }

  async updateInstagramMapping(id: number, data: Partial<InstagramMapping>): Promise<InstagramMapping | undefined> {
    const [updatedMapping] = await db.update(instagramMappings)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(instagramMappings.id, id))
      .returning();
    return updatedMapping;
  }

  async deleteInstagramMapping(instagramId: string): Promise<boolean> {
    const result = await db.delete(instagramMappings)
      .where(eq(instagramMappings.instagramId, instagramId));
    return result.count > 0;
  }

  // OAuth state management operations
  async saveOAuthState(state: string, userId: number, platform: string): Promise<OAuthState> {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    
    const [oauthState] = await db.insert(oauthStates).values({
      state,
      userId,
      platform,
      expiresAt
    }).returning();
    
    return oauthState;
  }
  
  async getOAuthState(state: string): Promise<OAuthState | undefined> {
    const [oauthState] = await db.select().from(oauthStates)
      .where(and(
        eq(oauthStates.state, state),
        gte(oauthStates.expiresAt, new Date()) // Only return non-expired states
      ));
    
    return oauthState;
  }
  
  async deleteOAuthState(state: string): Promise<boolean> {
    const result = await db.delete(oauthStates).where(eq(oauthStates.state, state));
    return result.count > 0;
  }
  
  async cleanupExpiredOAuthStates(): Promise<number> {
    const result = await db.delete(oauthStates)
      .where(lte(oauthStates.expiresAt, new Date()));
    return result.count;
  }
}

// Use database storage implementation
export const storage = new DatabaseStorage();