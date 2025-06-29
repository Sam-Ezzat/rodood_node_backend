import { pgTable, text, serial, integer, boolean, timestamp, json, jsonb, date, real, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// User model
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("member"), // "admin" or "member"
  isAdmin: boolean("is_admin").default(false), // keeping for backward compatibility
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
  email: true,
  role: true,
  isAdmin: true,
});

// Page/account model (Facebook pages connected to the bot)
export const pages = pgTable("pages", {
  id: serial("id").primaryKey(),
  pageId: text("page_id").notNull().unique(),
  name: text("name").notNull(),
  platform: text("platform").notNull().default("Facebook"), // "Facebook", "Instagram"
  accessToken: text("access_token").notNull(),
  status: text("status").notNull().default("active"),
  assistantId: text("assistant_id"),
  metadata: json("metadata"), // For storing additional platform-specific configurations
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertPageSchema = createInsertSchema(pages).pick({
  pageId: true,
  name: true,
  platform: true,
  accessToken: true,
  status: true,
  assistantId: true,
  metadata: true,
});

// Conversation model (individual conversations with users)
export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  senderId: text("sender_id").notNull(),
  pageId: text("page_id").notNull(),
  messagingType: text("messaging_type").notNull(),
  status: text("status").notNull().default("active"),
  messageCount: integer("message_count").notNull().default(0),
  lastMessageAt: timestamp("last_message_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertConversationSchema = createInsertSchema(conversations).pick({
  senderId: true,
  pageId: true,
  messagingType: true,
  status: true,
});

// Message model (individual messages within conversations)
export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull(),
  sender: text("sender").notNull(), // 'user', 'bot'
  text: text("text").notNull(),
  responseTime: integer("response_time"), // milliseconds
  sentAt: timestamp("sent_at").defaultNow(),
});

export const insertMessageSchema = createInsertSchema(messages).pick({
  conversationId: true,
  sender: true,
  text: true,
  responseTime: true,
});

// API Keys/Secrets
export const apiConfigs = pgTable("api_configs", {
  id: serial("id").primaryKey(),
  service: text("service").notNull().unique(),
  apiKey: text("api_key").notNull(),
  isActive: boolean("is_active").default(true),
  lastCheckedAt: timestamp("last_checked_at"),
  metadata: json("metadata"),
});

export const insertApiConfigSchema = createInsertSchema(apiConfigs).pick({
  service: true,
  apiKey: true,
  isActive: true,
  metadata: true,
});

// User-Page ownership junction table
export const userPages = pgTable("user_pages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  pageId: text("page_id").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUserPageSchema = createInsertSchema(userPages).pick({
  userId: true,
  pageId: true,
});

// Activity logging
export const activities = pgTable("activities", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(), // 'conversation', 'webhook', 'system'
  description: text("description").notNull(),
  metadata: json("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertActivitySchema = createInsertSchema(activities).pick({
  type: true,
  description: true,
  metadata: true,
});

// Types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type Page = typeof pages.$inferSelect;
export type InsertPage = z.infer<typeof insertPageSchema>;

export type UserPage = typeof userPages.$inferSelect;
export type InsertUserPage = z.infer<typeof insertUserPageSchema>;

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

export type ApiConfig = typeof apiConfigs.$inferSelect;
export type InsertApiConfig = z.infer<typeof insertApiConfigSchema>;

export type Activity = typeof activities.$inferSelect;
export type InsertActivity = z.infer<typeof insertActivitySchema>;

// User State model (for tracking user state in chatbot conversations)
export const userStates = pgTable("user_states", {
  id: serial("id").primaryKey(),
  senderId: text("sender_id").notNull().unique(),
  pageId: text("page_id").notNull(),
  messageCount: integer("message_count").notNull().default(0),
  labels: jsonb("labels").default([]),
  conversationId: integer("conversation_id"),
  threadId: text("thread_id"),
  runId: text("run_id"),
  isNewUser: boolean("is_new_user").default(false),
  hasStopMessage: boolean("has_stop_message").default(false),
  lastMessage: text("last_message"),
  lastMessageTime: timestamp("last_message_time").defaultNow(),
  rank: integer("rank"),
  messagesContext: jsonb("messages_context").default([]),
  conversation: jsonb("conversation").default([]),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUserStateSchema = createInsertSchema(userStates).pick({
  senderId: true,
  pageId: true,
  messageCount: true,
  labels: true,
  conversationId: true,
  threadId: true,
  runId: true,
  isNewUser: true,
  hasStopMessage: true,
  lastMessage: true,
  lastMessageTime: true,
  rank: true,
  messagesContext: true,
  conversation: true,
});

// UserState type definitions
export type UserState = typeof userStates.$inferSelect;
export type InsertUserState = z.infer<typeof insertUserStateSchema>;

// Dashboard Insights table
export const dashboardInsights = pgTable("dashboard_insights", {
  id: serial("id").primaryKey(),
  pageId: text("page_id").notNull().references(() => pages.pageId),
  date: timestamp("date").notNull(),
  timePeriod: text("time_period").notNull(),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  totalConversations: integer("total_conversations").notNull().default(0),
  totalMessages: integer("total_messages").notNull().default(0),
  averageResponseTime: real("average_response_time").notNull().default(0),
  completionRate: real("completion_rate").notNull().default(0),
  sentimentPositive: integer("sentiment_positive").notNull().default(0),
  sentimentNeutral: integer("sentiment_neutral").notNull().default(0),
  sentimentNegative: integer("sentiment_negative").notNull().default(0),
  averageSentiment: real("average_sentiment").notNull().default(0),
  conversationTrend: jsonb("conversation_trend").default([]),
  sentimentDistribution: jsonb("sentiment_distribution").default([]),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertDashboardInsightSchema = createInsertSchema(dashboardInsights).pick({
  pageId: true,
  date: true,
  timePeriod: true,
  startDate: true,
  endDate: true,
  totalConversations: true,
  totalMessages: true,
  averageResponseTime: true,
  completionRate: true,
  sentimentPositive: true,
  sentimentNeutral: true,
  sentimentNegative: true,
  averageSentiment: true,
  conversationTrend: true,
  sentimentDistribution: true,
});

// Sentiment Distribution table
export const sentimentDistribution = pgTable("sentiment_distribution", {
  id: serial("id").primaryKey(),
  pageId: text("page_id").notNull().references(() => pages.pageId),
  senderId: text("sender_id").notNull().references(() => userStates.senderId),
  rank: real("rank").notNull(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSentimentDistributionSchema = createInsertSchema(sentimentDistribution).pick({
  pageId: true,
  senderId: true,
  rank: true,
  label: true
});

export type DashboardInsight = typeof dashboardInsights.$inferSelect;
export type InsertDashboardInsight = z.infer<typeof insertDashboardInsightSchema>;
export type SentimentDistribution = typeof sentimentDistribution.$inferSelect;
export type InsertSentimentDistribution = z.infer<typeof insertSentimentDistributionSchema>;

// Interface for dashboard metrics (keeping for backward compatibility)
export interface DashboardMetrics {
  totalConversations: number;
  averageResponseTime: number; // in seconds
  completionRate: number; // percentage
  conversationTrend: Array<{
    date: string;
    count: number;
  }>;
}

// Instagram-to-Facebook mapping table for supporting Button #3 connections
export const instagramMappings = pgTable("instagram_mappings", {
  id: serial("id").primaryKey(),
  instagramId: text("instagram_id").notNull().unique(),
  facebookPageId: text("facebook_page_id").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertInstagramMappingSchema = createInsertSchema(instagramMappings).pick({
  instagramId: true,
  facebookPageId: true,
  status: true,
});

export type InstagramMapping = typeof instagramMappings.$inferSelect;
export type InsertInstagramMapping = z.infer<typeof insertInstagramMappingSchema>;

// OAuth state tracking table for reliable user assignment
export const oauthStates = pgTable("oauth_states", {
  id: serial("id").primaryKey(),
  state: text("state").notNull().unique(),
  userId: integer("user_id").notNull(),
  platform: text("platform").notNull(), // "facebook", "instagram"
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const insertOAuthStateSchema = createInsertSchema(oauthStates).pick({
  state: true,
  userId: true,
  platform: true,
  expiresAt: true,
});

export type OAuthState = typeof oauthStates.$inferSelect;
export type InsertOAuthState = z.infer<typeof insertOAuthStateSchema>;

// Page configuration interface for unified metadata storage
export const insertPageConfigSchema = z.object({
  pageId: z.string(),
  greetingMessage: z.string().optional(),
  firstMessage: z.string().optional(),
  maxMessages: z.number().int().optional(),
  endMessage: z.string().optional(),
  stopMessage: z.string().optional(),
});

export type PageConfig = {
  pageId: string;
  greetingMessage?: string;
  firstMessage?: string;
  maxMessages?: number;
  endMessage?: string;
  stopMessage?: string;
};
export type InsertPageConfig = z.infer<typeof insertPageConfigSchema>;
