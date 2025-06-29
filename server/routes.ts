import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertUserSchema, insertPageSchema, insertPageConfigSchema, insertMessageSchema, insertConversationSchema, type User as DbUser } from "@shared/schema";
import { ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import { setupFacebookWebhook } from "./api/facebook";
// Import the Facebook and Instagram OAuth routers
import facebookOAuthRouter from "./api/facebook-oauth";
import instagramOAuthRouter from "./api/instagram-oauth";
import publicEndpointsRouter from "./api/public-endpoints";
import insightsRouter from "./api/insights";
import testEndpointsRouter from "./api/test-endpoints";
import { initializeOpenAIConfig } from "./api/openai";
import { initializeDatabaseFromConfig } from "./init-db";
import { setupConfigBridgeEndpoints } from "./api/config-bridge";
import { log } from "./vite";
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { scrypt, timingSafeEqual, randomBytes } from "crypto";
import { promisify } from "util";

// Helper to validate request body against a schema
const validateBody = (body: unknown, schema: any) => {
  try {
    return { data: schema.parse(body), error: null };
  } catch (error) {
    if (error instanceof ZodError) {
      return { data: null, error: fromZodError(error).message };
    }
    return { data: null, error: "Invalid input data" };
  }
};

// Authentication middleware
const authenticate = (req: Request, res: Response, next: NextFunction) => {
  // Skip authentication for internal endpoints
  if (req.path.startsWith('/api/internal/')) {
    console.log(`Allowing internal access to: ${req.path}`);
    return next();
  }
  
  // Try multiple authentication methods in order of priority
  let userId = req.headers['x-user-id'];
  
  // If no header auth, try session-based auth
  if (!userId && req.session && (req.session as any).user) {
    userId = (req.session as any).user.id?.toString();
  }
  
  // If still no auth, try passport user object
  if (!userId && req.user && (req.user as any).id) {
    userId = (req.user as any).id.toString();
  }
  
  if (!userId) {
    // Check if this is a protected endpoint
    const publicEndpoints = [
      '/api/auth/login', 
      '/api/auth/register',
      '/api/public/instagram-pages',  // Add our public debugging endpoint
      '/api/python/analyze-sentiment', // Allow sentiment analysis testing without auth
      '/api/facebook/oauth-init', // Allow Facebook OAuth initialization without auth
      '/api/facebook/oauth-callback', // Allow Facebook OAuth callback without auth
      '/api/instagram/oauth-direct', // Allow direct Instagram OAuth initialization without auth
      '/api/instagram/oauth-facebook' // Allow Instagram Facebook OAuth initialization without auth
      // REMOVED Instagram callback endpoints - These REQUIRE authentication to assign pages to users:
      // - '/api/instagram/direct-callback' 
      // - '/api/instagram/facebook-callback'
      // REMOVED: '/api/facebook/connect-pages' - This endpoint REQUIRES authentication to assign pages to users
    ];
    
    // If the path is in the publicEndpoints list, allow access without authentication
    if (publicEndpoints.includes(req.path) || 
        req.path.startsWith('/api/auth/') || 
        req.path.startsWith('/api/public/') ||
        req.path.startsWith('/api/internal/') ||
        req.path.startsWith('/api/instagram/')) {
      console.log(`Allowing unauthenticated access to ${req.path}`);
      return next();
    }
    
    return res.status(401).json({ message: "Authentication required" });
  }
  
  // Get the user by ID
  const userIdNum = parseInt(userId as string);
  if (isNaN(userIdNum)) {
    return res.status(401).json({ message: "Invalid user ID" });
  }
  
  // Attach the user to the request object
  storage.getUser(userIdNum)
    .then(user => {
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }
      
      // Attach user to request
      req.user = user;
      next();
    })
    .catch(err => {
      console.error("Authentication error:", err);
      return res.status(500).json({ message: "Authentication failed" });
    });
};

// Authorization middleware for page access
const authorizePageAccess = (req: Request, res: Response, next: NextFunction) => {
  // If no user is authenticated, deny access
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  
  // Get the page ID from the request (query param, body, or route param)
  const pageId = req.query.pageId || req.body.pageId || req.params.pageId;
  
  if (!pageId) {
    return res.status(400).json({ message: "Page ID is required" });
  }
  
  // Check if the user has access to this page
  storage.isUserAuthorizedForPage(req.user!.id, String(pageId))
    .then(hasAccess => {
      if (!hasAccess) {
        return res.status(403).json({ 
          message: "You don't have permission to access this page" 
        });
      }
      
      // User is authorized
      next();
    })
    .catch(err => {
      console.error("Authorization error:", err);
      return res.status(500).json({ message: "Authorization check failed" });
    });
};

// Admin authorization middleware
const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  
  const user = req.user as DbUser;
  if (user.isAdmin) {
    next();
  } else {
    res.status(403).json({ message: "Administrator privileges required" });
  }
};

// Define custom request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: DbUser;
    }
  }
}

// Track connected WebSocket clients
const clients = new Map();

// Send dashboard metrics to all connected clients
const broadcastDashboardUpdates = async (pageId: string) => {
  const connectedClients = Array.from(clients.values())
    .filter((client: any) => 
      client.readyState === WebSocket.OPEN && 
      client.pageId === pageId
    );
  
  if (connectedClients.length === 0) return; // No clients connected for this page
  
  try {
    // Fetch latest metrics
    const fetch = (await import('node-fetch')).default;
    const { getPythonApiUrl } = await import('./api/python-api');
    
    // Get the appropriate URL for the current environment
    const pythonApiUrl = getPythonApiUrl('/api/insights');
    console.log(`[Metrics] Using Python API URL: ${pythonApiUrl}`);
    
    const response = await fetch(
      pythonApiUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: pageId,
          days: 7 // Default time range
        })
      }
    );
    
    if (!response.ok) {
      log(`Error fetching metrics for broadcast: ${response.statusText}`, 'websocket');
      return;
    }
    
    const responseData = await response.json() as {
      success: boolean;
      data?: {
        totalConversations?: number;
        averageResponseTime?: number;
        completionRate?: number;
        conversationTrend?: Array<{date: string; count: number}>;
        sentimentDistribution?: Array<{rank: number; count: number}>;
      };
      error?: string;
    };
    
    if (!responseData.success || !responseData.data) {
      log(`Invalid data for broadcast: ${responseData.error || 'Unknown error'}`, 'websocket');
      return;
    }
    
    const data = responseData.data;
    
    // Format metrics response
    const metricsData = {
      metrics: {
        totalConversations: data.totalConversations || 0,
        averageResponseTime: data.averageResponseTime || 0,
        completionRate: data.completionRate || 0,
        conversationTrend: data.conversationTrend || [],
        sentimentDistribution: data.sentimentDistribution || []
      }
    };
    
    // Send to all connected clients for this page
    const message = JSON.stringify({
      type: 'dashboardUpdate',
      data: metricsData,
      timestamp: new Date().toISOString()
    });
    
    log(`Broadcasting dashboard update to ${connectedClients.length} clients for page ${pageId}`, 'websocket');
    
    connectedClients.forEach((client: any) => {
      try {
        client.send(message);
      } catch (err) {
        console.error('Error sending message to client:', err);
      }
    });
  } catch (error) {
    console.error('Error broadcasting dashboard updates:', error);
  }
};

// Helper function and constants for websocket are defined above

// Password hashing and comparison functions
const scryptAsync = promisify(scrypt);

// Function to hash a password
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

// Function to compare a plaintext password with a hashed one
async function comparePasswords(supplied: string, stored: string): Promise<boolean> {
  try {
    const [hashed, salt] = stored.split(".");
    if (!hashed || !salt) return false;
    
    const hashedBuf = Buffer.from(hashed, "hex");
    const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
    return timingSafeEqual(hashedBuf, suppliedBuf);
  } catch (error) {
    console.error("Error comparing passwords:", error);
    return false;
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // Initialize WebSocket server
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  
  log('WebSocket server initialized on path /ws', 'websocket');
  
  // Monitor WebSocket server events
  wss.on('listening', () => {
    console.log('WebSocket server is listening');
  });
  
  wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
  });
  
  // Log the number of connections periodically
  const connectionMonitor = setInterval(() => {
    const clientCount = Array.from(clients.values()).filter((client: any) => 
      client.readyState === WebSocket.OPEN
    ).length;
    console.log(`WebSocket status: ${clientCount} active client(s)`);
  }, 10000);
  
  // WebSocket connection handler
  wss.on('connection', (ws, req) => {
    const id = Math.random().toString(36).substring(2, 10);
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    log(`New WebSocket connection established: ${id} from ${clientIp}`, 'websocket');
    
    // Store client in map
    clients.set(id, ws);
    
    // Handle client messages
    ws.on('message', (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        log(`Received message from client ${id}: ${JSON.stringify(data)}`, 'websocket');
        
        // Handle subscription requests
        if (data.type === 'subscribe') {
          if (data.pageId) {
            // Store the page ID in the client object for filtering
            (ws as any).pageId = data.pageId;
            log(`Client ${id} subscribed to updates for page ${data.pageId}`, 'websocket');
            
            // Send initial data
            broadcastDashboardUpdates(data.pageId);
          }
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
      }
    });
    
    // Handle client disconnection
    ws.on('close', () => {
      clients.delete(id);
      log(`WebSocket connection closed: ${id}`, 'websocket');
    });
    
    // Send initial message
    ws.send(JSON.stringify({
      type: 'welcome',
      message: 'Connected to WebSocket server',
      id,
      timestamp: new Date().toISOString()
    }));
  });

  // Initialize API services
  await initializeOpenAIConfig();

  // Initialize database with pages from Python config
  try {
    const result = await initializeDatabaseFromConfig();
    if (result) {
      log('Successfully initialized database with pages from Python config', 'routes');
    } else {
      log('Failed to initialize database with pages from Python config', 'routes');
    }
  } catch (error) {
    log(`Error initializing database: ${error}`, 'routes');
  }

  // Setup Facebook webhook
  setupFacebookWebhook(app);
  
  // Setup config bridge endpoints for Python integration
  setupConfigBridgeEndpoints(app);
  
  // Setup Python API proxy to handle requests in both local and production environments
  const { createPythonApiProxy } = await import('./api/python-proxy');
  app.use('/api/python', createPythonApiProxy());
  log('Python API proxy initialized on /api/python', 'routes');
  
  // Authentication routes (must be before the auth middleware)
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      
      if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }
      
      const user = await storage.getUserByEmail(email);
      
      if (!user) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      // Check if password is hashed (contains a dot separator between hash and salt)
      const isPasswordHashed = user.password.includes('.');
      
      let passwordValid = false;
      if (isPasswordHashed) {
        // If password is hashed, use our compare function
        passwordValid = await comparePasswords(password, user.password);
      } else {
        // For backward compatibility with non-hashed passwords
        passwordValid = (user.password === password);
      }
      
      if (!passwordValid) {
        console.log(`Invalid password attempt for user: ${email}`);
        return res.status(401).json({ message: "Invalid email or password" });
      }
      
      // Generate a session ID
      const sessionId = randomBytes(16).toString('hex');
      
      // Create session (simplified for demo - would use proper JWT in production)
      return res.status(200).json({
        id: user.id,
        username: user.username,
        email: user.email,
        isAdmin: user.isAdmin,
        sessionId // Send session ID to client for better tracking
      });
    } catch (error) {
      console.error("Login error:", error);
      return res.status(500).json({ message: "Authentication failed" });
    }
  });
  
  // User logout endpoint
  app.post("/api/auth/logout", (req, res) => {
    console.log("User logout request received");
    return res.status(200).json({ success: true, message: "Logged out successfully" });
  });
  
  // User registration route
  app.post("/api/auth/register", async (req, res) => {
    try {
      const { username, email, password, role, isAdmin } = req.body;
      
      // Validate required fields
      if (!username || !email || !password) {
        return res.status(400).json({ message: "Username, email, and password are required" });
      }
      
      // Check if user with this email already exists
      const existingUserByEmail = await storage.getUserByEmail(email);
      if (existingUserByEmail) {
        return res.status(400).json({ message: "A user with this email already exists" });
      }
      
      // Check if user with this username already exists
      const existingUserByUsername = await storage.getUserByUsername(username);
      if (existingUserByUsername) {
        return res.status(400).json({ message: "A user with this username already exists" });
      }
      
      // Hash the password
      const hashedPassword = await hashPassword(password);
      
      // Create the new user with the hashed password
      const newUser = await storage.createUser({
        username,
        email,
        password: hashedPassword,
        role: role || "member",
        isAdmin: isAdmin || false
      });
      
      // Return the user without sensitive information
      return res.status(201).json({
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        isAdmin: newUser.isAdmin
      });
    } catch (error) {
      console.error("Registration error:", error);
      return res.status(500).json({ message: "Registration failed" });
    }
  });
  
  // Simple cache for page configurations to reduce database load
  const configCache = new Map();
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  
  // Make cache available globally for other modules
  (global as any).configCache = configCache;

  // Register internal endpoints BEFORE authentication middleware
  app.get("/api/internal/pages/:pageId", async (req, res) => {
    try {
      const pageId = req.params.pageId;
      const cacheKey = `page_${pageId}`;
      const now = Date.now();
      
      // Check cache first
      const cached = configCache.get(cacheKey);
      if (cached && (now - cached.timestamp) < CACHE_TTL) {
        console.log(`[Internal] Returning cached page data for ${pageId}`);
        return res.status(200).json(cached.data);
      }
      
      console.log(`[Internal] Getting page data for ${pageId}`);
      const page = await storage.getPageById(pageId);
      
      if (!page) {
        console.log(`[Internal] No page found for ${pageId}`);
        return res.status(404).json({ message: "Page not found" });
      }
      
      // Cache the result
      configCache.set(cacheKey, {
        data: page,
        timestamp: now
      });
      
      console.log(`[Internal] Returning page data for ${pageId}`);
      return res.status(200).json(page);
    } catch (error) {
      console.error("Get internal page data error:", error);
      return res.status(500).json({ message: "Failed to get page data" });
    }
  });

  app.get("/api/internal/pageconfigs/:pageId", async (req, res) => {
    try {
      const pageId = req.params.pageId;
      const cacheKey = `config_${pageId}`;
      const now = Date.now();
      
      // Check cache first
      const cached = configCache.get(cacheKey);
      if (cached && (now - cached.timestamp) < CACHE_TTL) {
        console.log(`[Internal] Returning cached config for ${pageId}`);
        return res.status(200).json(cached.data);
      }
      
      console.log(`[Internal] Getting page config for ${pageId}`);
      
      // Get page with metadata directly
      const page = await storage.getPageById(pageId);
      
      let result;
      if (page) {
        // Extract config from page metadata
        const metadata = (page.metadata as any) || {};
        result = {
          pageId,
          greetingMessage: metadata.greetingMessage || "",
          firstMessage: metadata.firstMessage || "honored to know your name and where are you from?",
          maxMessages: metadata.maxMessages || 10,
          endMessage: metadata.endMessage || "Excuse me i need to go, we will continue our talk later",
          stopMessage: metadata.stopMessage || "*"
        };
        console.log(`[Internal] Extracted config from metadata for ${pageId}:`, result);
      } else {
        // Return defaults if page not found
        result = {
          pageId,
          greetingMessage: "",
          firstMessage: "",
          maxMessages: 10,
          endMessage: "",
          stopMessage: ""
        };
        console.log(`[Internal] Page not found, returning defaults for ${pageId}`);
      }
      
      // Cache the result
      configCache.set(cacheKey, {
        data: result,
        timestamp: now
      });
      
      if (!page) {
        console.log(`[Internal] No page found for ${pageId}, returning defaults`);
      } else {
        console.log(`[Internal] Returning config for ${pageId}`);
      }
      
      return res.status(200).json(result);
    } catch (error) {
      console.error("Get internal page config error:", error);
      return res.status(500).json({ message: "Failed to get page configuration" });
    }
  });

  // Facebook OAuth routes - use the new router which provides a complete OAuth flow
  app.use("/api/facebook", facebookOAuthRouter);
  app.use("/api/instagram", instagramOAuthRouter);
  
  // Use the imported publicEndpointsRouter for public routes
  // All routes are already defined in server/api/public-endpoints.ts
  
  // Apply authentication middleware to all other API routes EXCEPT public, insights, and test ones
  app.use('/api', (req, res, next) => {
    // Skip authentication for public routes, insights, and test endpoints in development
    if (req.path.startsWith('/public/') || 
        req.path.startsWith('/insights/') || 
        (process.env.NODE_ENV === 'development' && req.path.startsWith('/test/'))) {
      log(`Bypassing authentication for: ${req.path}`, 'routes');
      return next();
    }
    // Apply authentication for all other API routes
    return authenticate(req, res, next);
  });
  
  // Mount the imported publicEndpointsRouter AFTER authentication middleware
  app.use('/api/public', publicEndpointsRouter);
  
  // Mount the insights router for time-based insights calculations
  app.use('/api/insights', insightsRouter);
  
  // Add protected routes that require authentication - no need for middleware here now  
  app.get('/api/pages', authenticate, async (req: Request, res: Response) => {
    try {
      const user = req.user as DbUser;
      console.log(`GET /api/pages - User auth status: ${user ? `Authenticated as ${user.isAdmin ? 'admin' : 'user'} (id: ${user.id})` : 'Not authenticated'}`);
      
      let pages;
      if (user.isAdmin) {
        // Admin can see all pages
        console.log('[storage] Fetching all pages from database...');
        pages = await storage.getAllPages();
        console.log(`[storage] Retrieved ${pages.length} pages from database`);
        console.log('All pages in database:', pages.map(p => ({ 
          id: p.id, 
          name: p.name, 
          pageId: p.pageId, 
          platform: p.platform,
          metadata: p.metadata
        })));
      } else {
        // Regular users only see their assigned pages
        pages = await storage.getUserPages(user.id);
      }
      
      // Filter Instagram pages for debugging
      const instagramPages = pages.filter(page => page.platform === 'Instagram');
      if (instagramPages.length > 0) {
        console.log('Instagram pages found:', instagramPages.map(p => ({ 
          id: p.id, 
          name: p.name, 
          pageId: p.pageId, 
          platform: p.platform,
          metadata: p.metadata
        })));
      }
      
      console.log(`${user.isAdmin ? 'Admin user' : 'Regular user'}, returning ${user.isAdmin ? 'all' : 'assigned'} pages`);
      return res.status(200).json(pages);
    } catch (error) {
      console.error('Error fetching pages:', error);
      return res.status(500).json({ message: 'Failed to fetch pages' });
    }
  });
  
  // Add API endpoint to get API configurations
  app.get('/api/apiconfigs', authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
      const configs = await storage.getAllApiConfigs();
      return res.status(200).json(configs);
    } catch (error) {
      console.error('Error fetching API configs:', error);
      return res.status(500).json({ message: 'Failed to fetch API configurations' });
    }
  });
  
  // The dashboard endpoint has been moved to publicRouter
  
  // Authentication middleware is already applied above
  // No need for another middleware layer here
  
  // Register test endpoints with no authentication in development mode
  if (process.env.NODE_ENV === 'development') {
    // These endpoints bypass authentication for testing purposes
    app.use('/api/test', (req, res, next) => {
      // Skip authentication for test endpoints in development
      log(`Bypassing authentication for test endpoint: ${req.path}`, 'routes');
      next();
    }, testEndpointsRouter);
    log('Test endpoints registered at /api/test with AUTHENTICATION BYPASSED (DEVELOPMENT ONLY)', 'routes');
  }
  
  // Test endpoints for stop_message functionality
  app.get('/api/test/conversations/by-sender', async (req: Request, res: Response) => {
    try {
      const { senderId, pageId } = req.query;
      
      if (!senderId || !pageId) {
        return res.status(400).json({ error: 'senderId and pageId are required' });
      }
      
      const conversation = await storage.getConversationBySenderId(String(senderId), String(pageId));
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      
      return res.status(200).json(conversation);
    } catch (error) {
      console.error('Error fetching conversation:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/test/conversations/:id/messages', async (req: Request, res: Response) => {
    try {
      const conversationId = parseInt(req.params.id);
      
      if (isNaN(conversationId)) {
        return res.status(400).json({ error: 'Invalid conversation ID' });
      }
      
      const messages = await storage.getMessagesByConversation(conversationId);
      return res.status(200).json(messages);
    } catch (error) {
      console.error('Error fetching messages:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/test/messages', async (req: Request, res: Response) => {
    try {
      const { conversationId, sender, text, responseTime } = req.body;
      
      if (!conversationId || !sender || text === undefined) {
        return res.status(400).json({ error: 'conversationId, sender, and text are required' });
      }
      
      const message = await storage.createMessage({
        conversationId,
        sender,
        text,
        responseTime: responseTime || 0
      });
      
      return res.status(200).json(message);
    } catch (error) {
      console.error('Error creating message:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Authentication - This route is duplicated above before the authentication middleware

  // Legacy dashboard route - remove this after updating frontend
  // This is now replaced by the /api/dashboard route at the bottom of this file

  // Pages endpoints
  app.get("/api/pages", async (req, res) => {
    try {
      // Add debug logging to understand authentication status
      console.log('GET /api/pages - User auth status:', req.user ? `Authenticated as ${req.user.username} (id: ${req.user.id})` : 'Not authenticated');
      
      // Fetch all pages for debugging
      const allPages = await storage.getAllPages();
      console.log('All pages in database:', allPages.map(p => ({ 
        id: p.id, 
        name: p.name, 
        pageId: p.pageId, 
        platform: p.platform,
        metadata: p.metadata
      })));
      
      // Log Instagram pages separately to help with debugging
      const instagramPages = allPages.filter(p => p.platform === 'Instagram');
      if (instagramPages.length > 0) {
        console.log('Instagram pages found:', instagramPages.map(p => ({ 
          id: p.id, 
          name: p.name, 
          pageId: p.pageId, 
          platform: p.platform,
          fbPageId: p.metadata && typeof p.metadata === 'object' ? (p.metadata as {fbPageId?: string}).fbPageId : undefined
        })));
      } else {
        console.log('No Instagram pages found in database');
      }
      
      // For testing purposes, if no user is authenticated, return all pages
      // This ensures the dashboard shows pages even without authentication
      if (!req.user) {
        console.log('No user authenticated, returning all pages for testing');
        return res.status(200).json(allPages);
      }
      
      // If user is admin, return all pages
      if (req.user && req.user.isAdmin) {
        console.log('Admin user, returning all pages');
        return res.status(200).json(allPages);
      } 
      // If user is authenticated but not admin, return only pages they have access to
      else if (req.user) {
        console.log('Regular user, returning user-specific pages');
        const pages = await storage.getUserPages(req.user.id);
        return res.status(200).json(pages);
      }
      // This should never be reached but added as fallback
      else {
        return res.status(200).json([]);
      }
    } catch (error) {
      console.error("Get pages error:", error);
      return res.status(500).json({ message: "Failed to fetch pages" });
    }
  });
  
  // Public endpoints are defined in publicEndpointsRouter
  // We don't need to add them here

  app.post("/api/pages", authenticate, async (req, res) => {
    try {
      const { data, error } = validateBody(req.body, insertPageSchema);
      
      if (error) {
        return res.status(400).json({ message: error });
      }
      
      const page = await storage.createPage(data);
      
      // Automatically assign the page to the user who created it (unless they're admin)
      const user = req.user as DbUser;
      if (!user.isAdmin && page.id) {
        await storage.assignPageToUser(user.id, page.pageId);
      }
      
      return res.status(201).json(page);
    } catch (error) {
      console.error("Create page error:", error);
      return res.status(500).json({ message: "Failed to create page" });
    }
  });

  app.put("/api/pages/:id", authenticate, requireAdmin, async (req, res) => {
    
    try {
      const id = parseInt(req.params.id);
      
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid page ID" });
      }
      
      const page = await storage.getPage(id);
      
      if (!page) {
        return res.status(404).json({ message: "Page not found" });
      }
      
      // Check if user is admin or owner of the page
      const isAuthorized = req.user.isAdmin || await storage.isUserAuthorizedForPage(req.user.id, page.pageId);
      if (!isAuthorized) {
        return res.status(403).json({ message: "You don't have permission to update this page" });
      }
      
      const { data, error } = validateBody(req.body, insertPageSchema.partial());
      
      if (error) {
        return res.status(400).json({ message: error });
      }
      
      const updatedPage = await storage.updatePage(id, data);
      return res.status(200).json(updatedPage);
    } catch (error) {
      console.error("Update page error:", error);
      return res.status(500).json({ message: "Failed to update page" });
    }
  });
  
  // Internal page configuration endpoint for Python system (no auth required)
  app.get("/api/internal/pageconfigs/:pageId", async (req, res) => {
    try {
      const pageId = req.params.pageId;
      console.log(`[Internal] Getting page config for ${pageId}`);
      
      // Bypass cache and get page data directly from database
      const page = await storage.getPageById(pageId);
      console.log(`[Internal] Page retrieval result for ${pageId}:`, page ? 'Found' : 'Not found');
      
      if (page) {
        // Extract config from page metadata
        const metadata = (page.metadata as any) || {};
        console.log(`[Internal] Raw metadata for ${pageId}:`, metadata);
        
        const config = {
          pageId,
          greetingMessage: metadata.greetingMessage || "",
          firstMessage: metadata.firstMessage || "honored to know your name and where are you from?",
          maxMessages: metadata.maxMessages || 10,
          endMessage: metadata.endMessage || "Excuse me i need to go, we will continue our talk later",
          stopMessage: metadata.stopMessage || "*"
        };
        
        console.log(`[Internal] Extracted config for ${pageId}:`, config);
        return res.status(200).json(config);
      }
      
      // If no page found, return defaults immediately
      console.log(`[Internal] No page found for ${pageId}, returning defaults`);
      return res.status(200).json({
        pageId,
        greetingMessage: "",
        firstMessage: "",
        maxMessages: 10,
        endMessage: "",
        stopMessage: ""
      });
    } catch (error) {
      console.error(`[Internal] Get page config error for ${req.params.pageId}:`, error);
      return res.status(500).json({ message: "Failed to get page configuration" });
    }
  });

  // Page Configuration endpoints (authenticated) - unified with pages.metadata
  app.get("/api/pageconfigs/:pageId", async (req, res) => {
    // Check if user is authenticated
    if (!req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }
    
    try {
      const pageId = req.params.pageId;
      const config = await storage.getPageConfig(pageId);
      
      if (!config) {
        // Return default configuration if no page exists
        return res.status(200).json({
          pageId,
          greetingMessage: "",
          firstMessage: "",
          maxMessages: 10,
          endMessage: "",
          stopMessage: ""
        });
      }
      
      return res.status(200).json(config);
    } catch (error) {
      console.error("Get page config error:", error);
      return res.status(500).json({ message: "Failed to get page configuration" });
    }
  });

  app.put("/api/pageconfigs/:pageId", async (req, res) => {
    try {
      const pageId = req.params.pageId;
      const { data, error } = validateBody(req.body, insertPageConfigSchema.partial());
      
      if (error) {
        return res.status(400).json({ message: error });
      }
      
      const updatedConfig = await storage.updatePageConfig(pageId, data);
      
      // Clear cache for this page configuration
      const configCacheKey = `config_${pageId}`;
      const pageCacheKey = `page_${pageId}`;
      configCache.delete(configCacheKey);
      configCache.delete(pageCacheKey);
      console.log(`[Cache] Cleared cache for page ${pageId} after configuration update`);
      
      return res.status(200).json(updatedConfig);
    } catch (error) {
      console.error("Update page config error:", error);
      return res.status(500).json({ message: "Failed to update page configuration" });
    }
  });

  app.delete("/api/pages/:id", async (req, res) => {
    // Check if user is authenticated
    if (!req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }
    
    try {
      const id = parseInt(req.params.id);
      
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid page ID" });
      }
      
      const page = await storage.getPage(id);
      
      if (!page) {
        return res.status(404).json({ message: "Page not found" });
      }
      
      // Only allow admin users to delete pages, regardless of ownership
      const user = req.user as DbUser;
      if (!user.isAdmin) {
        return res.status(403).json({ 
          message: "Only administrators can delete pages. Contact an administrator if you need a page removed." 
        });
      }
      
      // Delete the page
      const result = await storage.deletePage(id);
      
      if (!result) {
        return res.status(500).json({ message: "Failed to delete page" });
      }
      
      // Create an activity record for the deletion
      await storage.createActivity({
        type: 'page_deletion',
        description: `Page "${page.name}" (ID: ${page.pageId}) removed by admin ${req.user.username} (ID: ${req.user.id})`,
        metadata: { 
          pageId: page.pageId,
          adminId: req.user.id,
          adminUsername: req.user.username
        }
      });
      
      return res.status(200).json({ success: true, message: "Page removed successfully" });
    } catch (error) {
      console.error("Delete page error:", error);
      return res.status(500).json({ message: "Failed to delete page" });
    }
  });
  
  app.get("/api/pages/:id", async (req, res) => {
    try {
      // Check if user is authenticated
      if (!req.user) {
        return res.status(401).json({ message: "Authentication required" });
      }
      
      const pageId = parseInt(req.params.id);
      
      if (isNaN(pageId)) {
        return res.status(400).json({ message: "Invalid page ID" });
      }
      
      const page = await storage.getPage(pageId);
      
      if (!page) {
        return res.status(404).json({ message: "Page not found" });
      }
      
      // Check if user is admin or authorized to access this page
      const isAuthorized = req.user.isAdmin || await storage.isUserAuthorizedForPage(req.user.id, page.pageId);
      if (!isAuthorized) {
        return res.status(403).json({ message: "You don't have permission to access this page" });
      }
      
      return res.status(200).json(page);
    } catch (error) {
      console.error("Get page error:", error);
      return res.status(500).json({ message: "Failed to fetch page" });
    }
  });

  // Chatbot tester API endpoint
  app.post("/api/test-chatbot", async (req, res) => {
    try {
      // Check if user is authenticated
      if (!req.user) {
        return res.status(401).json({ message: "Authentication required" });
      }
      
      const { pageId, message, senderId } = req.body;
      
      if (!pageId || !message) {
        return res.status(400).json({ 
          message: "Page ID and message are required"
        });
      }
      
      // Use provided senderId or generate a default one for thread persistence
      const effectiveSenderId = senderId || `tester_${pageId}`;
      
      log(`Testing chatbot for page ${pageId} with message: ${message}`, 'chatbot-tester');
      
      // Get the page to ensure it exists
      const page = await storage.getPageByPageId(pageId);
      
      if (!page) {
        return res.status(404).json({ message: "Page not found" });
      }
      
      // Check if user is admin or owner of the page
      if (!req.user.isAdmin) {
        const isAuthorized = await storage.isUserAuthorizedForPage(req.user.id, pageId);
        if (!isAuthorized) {
          return res.status(403).json({ message: "You don't have permission to test this chatbot" });
        }
      }
      
      try {
        // First attempt to use the Python API with the page's assistant_id
        const fetch = (await import('node-fetch')).default;
        try {
          // Get the assistant_id for this specific page
          const assistantId = page.assistantId || null;
          log(`Using assistant ID: ${assistantId || 'default'} for page ${pageId}`, 'chatbot-tester');
          
          // Log page details to help debug inconsistencies between environments
          log(`Page details: name=${page.name}, platform=${page.platform}, pageId=${page.pageId}, assistantId=${page.assistantId}`, 'chatbot-tester');
          
          // Call the Python API to process the message with page-specific assistant ID
          // Use the Python API proxy instead of hard-coded localhost URL
          const pythonUrl = `${process.env.PYTHON_API_URL || process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5000'}/api/message`;
          log(`Using Python API URL: ${pythonUrl}`, 'chatbot-tester');
          
          const pythonResponse = await fetch(pythonUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              message: message,
              page_id: pageId,
              message_count: 1,
              test_mode: true, // This indicates it's from the tester interface
              sender_id: effectiveSenderId, // Use the provided or default sender ID for thread persistence
              assistant_id: assistantId, // Pass the page-specific assistant ID - critical for consistency
              page_name: page.name, // Send additional page info for better debugging
              platform: page.platform
            })
          });
          
          if (!pythonResponse.ok) {
            throw new Error(`Python API error: ${pythonResponse.status} ${pythonResponse.statusText}`);
          }
          
          const responseData = await pythonResponse.json() as {
            success: boolean;
            error?: string;
            response: string;
            metadata?: Record<string, any>;
          };
          
          if (!responseData.success) {
            throw new Error(`Python API error: ${responseData.error || 'Unknown error'}`);
          }
          
          const responseText = responseData.response;
          
          // Record the test interaction
          await storage.createActivity({
            type: 'chatbot-test',
            description: `Chatbot test for page ${page.name}`,
            metadata: { 
              pageId,
              userMessage: message,
              botResponse: responseText.substring(0, 100) + (responseText.length > 100 ? '...' : ''),
              assistantId: page.assistantId || 'default',
              senderId: effectiveSenderId // Track the senderId for conversation context
            }
          });
          
          return res.json({ response: responseText });
        } catch (pythonError) {
          // If Python API fails, fall back to direct OpenAI integration
          log(`Python API error, falling back to direct OpenAI: ${pythonError}`, 'chatbot-tester');
          
          const { generateResponse } = await import('./api/openai');
          const response = await generateResponse(message, page.assistantId || 'default');
          
          if (!response) {
            throw new Error('No response generated from fallback');
          }
          
          // Record the test interaction (using fallback)
          await storage.createActivity({
            type: 'chatbot-test',
            description: `Chatbot test for page ${page.name} (fallback)`,
            metadata: { 
              pageId,
              userMessage: message,
              botResponse: response.substring(0, 100) + (response.length > 100 ? '...' : ''),
              assistantId: page.assistantId || 'default',
              fallback: true,
              senderId: effectiveSenderId // Track the senderId for conversation context
            }
          });
          
          return res.json({ response, fallback: true });
        }
      } catch (error: any) {
        log(`Error in chatbot test: ${error}`, 'chatbot-tester');
        return res.status(500).json({ 
          message: "Failed to generate response",
          error: error?.message || String(error)
        });
      }
    } catch (error) {
      console.error("Chatbot test error:", error);
      return res.status(500).json({ 
        message: "Failed to process chatbot test",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // API Configurations endpoints - admin only
  app.get("/api/apiconfigs", requireAdmin, async (req, res) => {
    try {
      const configs = await storage.getAllApiConfigs();
      return res.status(200).json(configs);
    } catch (error) {
      console.error("Get API configs error:", error);
      return res.status(500).json({ message: "Failed to fetch API configurations" });
    }
  });

  // Activities endpoints - admin only
  app.get("/api/activities", requireAdmin, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
      const activities = await storage.getRecentActivities(limit);
      return res.status(200).json(activities);
    } catch (error) {
      console.error("Get activities error:", error);
      return res.status(500).json({ message: "Failed to fetch activities" });
    }
  });

  // Chatbot message processing route
  app.post("/api/message", async (req, res) => {
    try {
      const { message, page_id, message_count } = req.body;
      
      if (!message) {
        return res.status(400).json({ error: 'Missing message' });
      }
      
      // Log the request
      log(`Processing message: "${message.substring(0, 30)}..." for page ${page_id || 'unknown'}`, 'api');
      
      // Get the assistant ID if this is a page-specific message
      let assistantId = undefined;
      if (page_id) {
        try {
          const page = await storage.getPageByPageId(page_id);
          if (page && page.assistantId) {
            assistantId = page.assistantId;
            log(`Using assistant ID ${assistantId} for page ${page_id}`, 'api');
          }
        } catch (err) {
          log(`Error retrieving page for assistant ID: ${err}`, 'api');
        }
      }
      
      // Forward to Python service with page_id, message_count, and assistant_id
      const fetch = (await import('node-fetch')).default;
      try {
        // Use the Python API proxy instead of hard-coded localhost URL
        const pythonUrl = `${process.env.PYTHON_API_URL || process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5000'}/api/message`;
        log(`Using Python API URL for message: ${pythonUrl}`, 'api');
        
        const response = await fetch(pythonUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ 
            message,
            page_id,
            message_count: message_count || 1,
            assistant_id: assistantId,  // Send the assistant ID to Python
            sender_id: req.body.sender_id || `api_user_${Date.now()}` // Include sender_id for conversation tracking
          })
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Python service error (${response.status}): ${errorText}`);
        }
        
        const data = await response.json() as {
          success: boolean;
          response: string;
          error?: string;
          metadata?: Record<string, any>;
        };
        
        if (!data.success) {
          throw new Error(data.error || 'Failed to process message');
        }
        
        // Log success with metadata
        log(`Python service responded with: "${data.response.substring(0, 30)}..."`, 'api');
        if (data.metadata) {
          log(`Response metadata: ${JSON.stringify(data.metadata)}`, 'api');
        }
        
        // Log the interaction
        await storage.createActivity({
          type: 'message',
          description: `Processed message through Python service for page ${page_id || 'unknown'}`,
          metadata: { 
            message, 
            response: data.response,
            page_id,
            message_count
          }
        });
        
        // Broadcast dashboard updates if page_id is present
        if (page_id) {
          // Use setTimeout to avoid blocking the response
          console.log('Scheduling real-time dashboard update for page_id:', page_id);
          setTimeout(() => {
            console.log('Executing real-time dashboard update broadcast for page_id:', page_id);
            broadcastDashboardUpdates(page_id);
          }, 500);
        }
        
        // Send response back to client
        res.setHeader('Content-Type', 'application/json');
        return res.json(data);
      } catch (error) {
        console.error('Error calling Python service:', error);
        
        // Fallback to OpenAI
        const { generateResponse } = await import('./api/openai');
        
        // Get the assistant ID for the page if provided
        let assistantId = 'default';
        if (page_id) {
          try {
            const page = await storage.getPageByPageId(page_id);
            if (page && page.assistantId) {
              assistantId = page.assistantId;
            }
          } catch (err) {
            console.error(`Error getting page for assistant ID: ${err}`);
          }
        }
        
        const botResponse = await generateResponse(message, assistantId);
        
        // Log the fallback interaction
        await storage.createActivity({
          type: 'message',
          description: `Processed message through fallback OpenAI integration for page ${page_id || 'unknown'}`,
          metadata: { 
            message, 
            response: botResponse,
            fallback: true,
            page_id,
            message_count
          }
        });
        
        // Broadcast dashboard updates for fallback responses too
        if (page_id) {
          console.log('Scheduling real-time dashboard update for page_id (fallback):', page_id);
          setTimeout(() => {
            console.log('Executing real-time dashboard update broadcast for page_id (fallback):', page_id);
            broadcastDashboardUpdates(page_id);
          }, 500);
        }
        
        res.setHeader('Content-Type', 'application/json');
        return res.json({
          success: true,
          response: botResponse || 'Sorry, I could not generate a response.',
          metadata: {
            fallback: true,
            assistant_id: assistantId,
            page_id: page_id
          }
        });
      }
    } catch (error: any) {
      console.error('Error processing message:', error);
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ 
        success: false,
        error: 'Failed to process message',
        message: error.message || String(error)
      });
    }
  });
  
  // Update OpenAI API key - admin only
  app.post("/api/settings/openai", requireAdmin, async (req, res) => {
    try {
      const { apiKey } = req.body;
      
      if (!apiKey) {
        return res.status(400).json({ error: 'Missing API key' });
      }
      
      // Simple validation to make sure it's a potentially valid OpenAI key
      if (!apiKey.startsWith('sk-') || apiKey.length < 20) {
        return res.status(400).json({ 
          error: 'Invalid API key format. OpenAI API keys should start with "sk-" and be at least 20 characters long.' 
        });
      }
      
      // Check if there's an existing OpenAI config
      let openaiConfig = await storage.getApiConfig('openai');
      
      if (openaiConfig) {
        // Update existing config
        await storage.updateApiConfig(openaiConfig.id, {
          ...openaiConfig,
          apiKey,
          isActive: true,
          metadata: {
            ...(openaiConfig.metadata || {}),
            lastUpdated: new Date().toISOString(),
            updatedBy: 'user_interface'
          }
        });
        log(`Updated OpenAI API key`, 'api');
      } else {
        // Create new config
        await storage.createApiConfig({
          service: 'openai',
          apiKey,
          isActive: true,
          metadata: {
            lastUpdated: new Date().toISOString(),
            createdBy: 'user_interface'
          }
        });
        log(`Created new OpenAI API config`, 'api');
      }
      
      // Set the environment variable for the current process
      process.env.OPENAI_API_KEY = apiKey;
      
      // Force reinitialize OpenAI client with the new key
      const { initializeOpenAIConfig } = await import('./api/openai');
      const initialized = await initializeOpenAIConfig();
      
      if (!initialized) {
        log(`Warning: Could not initialize OpenAI with new key`, 'api');
      }
      
      // Return success
      return res.json({
        success: true,
        message: 'OpenAI API key updated successfully'
      });
    } catch (error) {
      console.error('Error updating OpenAI API key:', error);
      return res.status(500).json({ 
        success: false,
        error: 'Failed to update OpenAI API key'
      });
    }
  });

  // Conversations endpoints
  app.get("/api/conversations", authorizePageAccess, async (req, res) => {
    try {
      const pageId = req.query.pageId as string;
      
      if (!pageId) {
        return res.status(400).json({ message: "Page ID is required" });
      }
      
      const conversations = await storage.getConversationsByPageId(pageId);
      return res.status(200).json(conversations);
    } catch (error) {
      console.error("Get conversations error:", error);
      return res.status(500).json({ message: "Failed to fetch conversations" });
    }
  });

  app.get("/api/conversations/:id/messages", async (req, res) => {
    // We need a different authorization approach here since we're accessing by conversation ID
    // First, get the conversation to determine the pageId
    try {
      const conversationId = parseInt(req.params.id);
      if (isNaN(conversationId)) {
        return res.status(400).json({ message: "Invalid conversation ID" });
      }
      
      const conversation = await storage.getConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }
      
      // Check user authorization for this page if user is authenticated
      if (req.user) {
        const isAuthorized = await storage.isUserAuthorizedForPage(req.user.id, conversation.pageId);
        if (!isAuthorized) {
          return res.status(403).json({ message: "You don't have permission to access this conversation" });
        }
      } else {
        // If not authenticated, reject access
        return res.status(401).json({ message: "Authentication required" });
      }
      
      // If we get here, user is authorized
      const messages = await storage.getMessagesByConversation(conversationId);
      return res.status(200).json(messages);
    } catch (error) {
      console.error("Get messages error:", error);
      return res.status(500).json({ message: "Failed to fetch messages" });
    }
  });
  
  // Chatbot testing endpoint
  app.post("/api/chatbot/test", authorizePageAccess, async (req, res) => {
    try {
      const { pageId, message, senderId } = req.body;
      
      if (!pageId || !message) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing pageId or message' 
        });
      }
      
      // Use the provided senderId or generate a unique one for thread persistence
      const effectiveSenderId = senderId || `test_user_${pageId}_${Date.now()}`;
      
      // Log the request
      log(`Testing chatbot: "${message.substring(0, 30)}..." for page ${pageId}`, 'api');
      
      // Get the page from storage to ensure it exists
      const page = await storage.getPageByPageId(pageId);
      if (!page) {
        return res.status(404).json({ 
          success: false,
          error: 'Page not found' 
        });
      }
      
      // Forward to Python service
      const fetch = (await import('node-fetch')).default;
      try {
        // Get the assistant ID for the page
        let assistantId = undefined;
        if (page && page.assistantId) {
          assistantId = page.assistantId;
          log(`Using assistant ID ${assistantId} for test on page ${pageId}`, 'api');
        }
        
        // Use the Python API proxy instead of hard-coded localhost URL
        const pythonUrl = `${process.env.PYTHON_API_URL || process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5000'}/api/message`;
        log(`Using Python API URL for test: ${pythonUrl}`, 'api');
        
        const response = await fetch(pythonUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ 
            message,
            page_id: pageId,
            message_count: 1, // Always treat as a single message in test mode
            test_mode: true, // Flag to indicate this is a test, not a real user message
            assistant_id: assistantId, // Pass the assistant ID to Python service
            sender_id: effectiveSenderId // Use the provided or generated sender ID for thread persistence
          })
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Python service error (${response.status}): ${errorText}`);
        }
        
        const data = await response.json() as {
          success: boolean;
          response: string;
          error?: string;
          metadata?: Record<string, any>;
        };
        
        if (!data.success) {
          throw new Error(data.error || 'Failed to process message');
        }
        
        // Create an activity record for the test
        await storage.createActivity({
          type: 'test_message',
          description: `Tested chatbot for page "${page.name}"`,
          metadata: {
            userMessage: message,
            botResponse: data.response,
            pageId: pageId,
            status: 'success'
          }
        });
        
        return res.status(200).json({ 
          success: true, 
          response: data.response,
          metadata: data.metadata 
        });
      } catch (error) {
        console.error('Error processing test message:', error);
        
        // Fallback to OpenAI when Python service fails
        try {
          const { generateResponse } = await import('./api/openai');
          
          // Get the assistant ID for the page
          let assistantId = 'default';
          if (page && page.assistantId) {
            assistantId = page.assistantId;
          }
          
          // Generate a response using the OpenAI API
          const response = await generateResponse(message, assistantId);
          
          // Create an activity record for the test with fallback response
          await storage.createActivity({
            type: 'test_message',
            description: `Tested chatbot for page "${page.name}" (OpenAI fallback)`,
            metadata: {
              userMessage: message,
              botResponse: response,
              pageId: pageId,
              fallback: true,
              status: 'success'
            }
          });
          
          return res.status(200).json({
            success: true,
            response,
            metadata: { fallback: true }
          });
        } catch (fallbackError) {
          console.error('Fallback error:', fallbackError);
          return res.status(500).json({ 
            success: false, 
            error: 'Failed to process message with both Python service and fallback'
          });
        }
      }
    } catch (error) {
      console.error('Chatbot test error:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to test chatbot' 
      });
    }
  });
  
  // Test endpoints for webhook testing
  app.post('/api/test/create-conversation', authorizePageAccess, async (req, res) => {
    try {
      const { senderId, pageId, isGreeting } = req.body;
      
      if (!senderId || !pageId) {
        return res.status(400).json({ error: 'Missing required parameters' });
      }
      
      // Create or get conversation
      let conversation = await storage.getConversationBySenderId(senderId, pageId);
      
      if (!conversation) {
        conversation = await storage.createConversation({
          senderId,
          pageId,
          messagingType: 'RESPONSE',
          status: 'active'
        });
      }
      
      // If isGreeting is true, create a greeting message from the page
      if (isGreeting) {
        // Get greeting message from config
        let greetingMessage = 'Hello! 👋 Thank you for your interest.';
        
        try {
          // Get greeting message from Python config using a temporary script
          const path = await import('path');
          const fs = await import('fs');
          const scriptPath = path.join(process.cwd(), 'chatbot', 'temp_config.py');
          const script = `
import config
import json
print(json.dumps({"greeting_message": config.get_greeting_message("${pageId}")}))
`;
          fs.writeFileSync(scriptPath, script);
          const { execSync } = await import('child_process');
          const output = execSync(`python ${scriptPath}`, { encoding: 'utf-8' });
          fs.unlinkSync(scriptPath);
          
          const result = JSON.parse(output.trim());
          greetingMessage = result.greeting_message || greetingMessage;
        } catch (error) {
          console.error('Error getting greeting message from config:', error);
        }
        
        // Store greeting message as from the bot
        await storage.createMessage({
          conversationId: conversation.id,
          sender: 'bot', // this is from the page/bot
          text: greetingMessage,
          responseTime: 0
        });
      }
      
      return res.status(200).json({
        conversationId: conversation.id,
        message: 'Conversation created successfully'
      });
    } catch (error) {
      console.error('Error creating test conversation:', error);
      return res.status(500).json({ error: 'Failed to create test conversation' });
    }
  });
  
  app.get('/api/test/conversation/:senderId/:pageId', async (req, res) => {
    try {
      const { pageId, senderId } = req.params;
      
      // Check if the user is authenticated and has access to this page
      if (req.user) {
        const isAuthorized = await storage.isUserAuthorizedForPage(req.user.id, pageId);
        if (!isAuthorized) {
          return res.status(403).json({ error: "You don't have permission to access this page" });
        }
      } else {
        // If not authenticated, reject access
        return res.status(401).json({ error: "Authentication required" });
      }
      
      // If we reach here, the user is authorized
      const conversation = await storage.getConversationBySenderId(senderId, pageId);
      
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      
      const messages = await storage.getMessagesByConversation(conversation.id);
      
      // Get the userState from pythonBridge
      const { pythonBridge } = await import('./api/python-bridge');
      
      // Special handling for test users to ensure labels are applied
      const isDevelopment = process.env.NODE_ENV === 'development';
      const isTestUser = isDevelopment && (
        senderId.includes('test') || 
        senderId.includes('fixed') || 
        senderId.startsWith('test_') || 
        senderId.startsWith('fixed_') ||
        senderId === 'correct_greeting_user' || 
        senderId === 'greeting_test_user'
      );
      
      // For test users, check if we need to add a label
      if (isTestUser && conversation.messageCount >= 2) {
        // If no user state yet, create one
        if (!(pythonBridge as any).userState[senderId]) {
          (pythonBridge as any).userState[senderId] = {
            page_id: pageId,
            message_count: 1,
            label: ['Rodood-Bot'],
            conversation: [],
            conversation_id: conversation.id,
            new_user: true,
            thread_id: null,
            run_id: null,
            messages_context: [],
            last_message_time: new Date(),
            has_stop_message: false,
            last_message: null
          };
        }
        // If has user state but no label, add label
        else if (!(pythonBridge as any).userState[senderId].label || 
                 (pythonBridge as any).userState[senderId].label.length === 0) {
          (pythonBridge as any).userState[senderId].label = ['Rodood-Bot'];
        }
        
        // Check if stop message is in conversation
        const stopMessage = messages.find(m => m.sender === 'bot' && m.text === '*');
        if (stopMessage && !(pythonBridge as any).userState[senderId].has_stop_message) {
          (pythonBridge as any).userState[senderId].has_stop_message = true;
        }
      }
      
      return res.status(200).json({
        conversation,
        messages,
        userState: (pythonBridge as any).userState[senderId] || null
      });
    } catch (error) {
      console.error('Error fetching test conversation:', error);
      return res.status(500).json({ error: 'Failed to fetch test conversation' });
    }
  });
  
  app.post('/api/test/update-user-state', authorizePageAccess, async (req, res) => {
    try {
      const { senderId, pageId, messageCount } = req.body;
      
      if (!senderId) {
        return res.status(400).json({ error: 'Missing senderId parameter' });
      }
      
      // Get pythonBridge to update user state
      const { pythonBridge } = await import('./api/python-bridge');
      
      // Update the user state in python-bridge
      if (!(pythonBridge as any).userState[senderId]) {
        (pythonBridge as any).userState[senderId] = {
          page_id: pageId,
          message_count: messageCount || 0,
          label: [],
          conversation: [],
          conversation_id: null,
          new_user: true,
          thread_id: null,
          run_id: null,
          messages_context: [],
          last_message_time: new Date(),
          has_stop_message: false,
          last_message: null
        };
      } else {
        if (messageCount !== undefined) {
          (pythonBridge as any).userState[senderId].message_count = messageCount;
        }
      }
      
      return res.status(200).json({
        message: 'User state updated successfully',
        userState: (pythonBridge as any).userState[senderId]
      });
    } catch (error) {
      console.error('Error updating user state:', error);
      return res.status(500).json({ error: 'Failed to update user state' });
    }
  });

  // Dashboard metrics endpoint
  app.get("/api/dashboard", async (req, res) => {
    // Check if user is authenticated
    if (!req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }
    
    const { pageId } = req.query;
    
    if (!pageId) {
      return res.status(400).json({ message: "Page ID is required" });
    }
    
    // Check if admin or authorized for this page
    const isAuthorized = req.user.isAdmin || await storage.isUserAuthorizedForPage(req.user.id, String(pageId));
    if (!isAuthorized) {
      return res.status(403).json({ message: "You don't have permission to access this page's dashboard" });
    }
    
    try {
      // Import the dashboard handler which uses our proxy
      const { handleDashboardRequest } = await import('./api/dashboard-endpoint');
      
      // Pass control to our handler which uses the Python API proxy
      await handleDashboardRequest(req, res);
    } catch (error: any) {
      console.error("Dashboard metrics error:", error);
      return res.status(500).json({ 
        message: "Failed to fetch dashboard metrics",
        error: error.message  
      });
    }
  });

  return httpServer;
}
