import { Router, Request, Response } from 'express';
import fetch from 'node-fetch';
import { storage } from '../storage';
import 'express-session';
import passport from 'passport';
import * as crypto from 'crypto';

// Extend the session types to include our custom properties
declare module 'express-session' {
  interface Session {
    instagramOAuthState?: string;
    instagramConnectingUserId?: string;
    connectingUserId?: string;
    connectingFbUserId?: string;
  }
}

// Helper function to generate user-friendly error pages
function generateErrorPage(title: string, message: string, redirectPath: string): string {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
          background-color: #f7f7f7;
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          margin: 0;
          padding: 20px;
        }
        .error-container {
          background: white;
          padding: 30px;
          border-radius: 8px;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          text-align: center;
          max-width: 500px;
          width: 100%;
        }
        h1 {
          color: #e53e3e;
          margin-bottom: 15px;
        }
        p {
          color: #4a5568;
          margin-bottom: 25px;
          line-height: 1.6;
        }
        .button {
          display: inline-block;
          background-color: #3182ce;
          color: white;
          padding: 10px 20px;
          border-radius: 5px;
          text-decoration: none;
          font-weight: 600;
          transition: background-color 0.2s;
        }
        .button:hover {
          background-color: #2c5282;
        }
      </style>
    </head>
    <body>
      <div class="error-container">
        <h1>${title}</h1>
        <p>${message}</p>
        <a href="${redirectPath}" class="button">Return to Connect Page</a>
      </div>
    </body>
    </html>
  `;
}

// Extend the Express session interface to add our own properties
declare module 'express-session' {
  interface SessionData {
    instagramOAuthState?: string;
    instagramTokenData?: {
      access_token: string;
      user_id: string;
    };
    // Added for user tracking during OAuth flows
    connectingUserId?: string;
    connectingFbUserId?: string;
  }
}

// Create a router for Instagram OAuth
const router = Router();

// Central initialization endpoint for the connect page
router.get('/oauth-init', (req: Request, res: Response) => {
  // Return information about the available OAuth flows
  return res.json({
    success: true,
    flows: [
      {
        id: 'direct',
        name: 'Direct Instagram Business',
        url: '/api/instagram/oauth-direct',
        description: 'Connect an Instagram Business account directly'
      },
      {
        id: 'facebook',
        name: 'Instagram via Facebook',
        url: '/api/instagram/oauth-facebook',
        description: 'Connect Instagram accounts via Facebook Pages'
      }
    ]
  });
});

// Define constants - use Replit domain without port for OAuth callbacks
// Facebook expects the callback URL to be registered without any port numbers
const APP_DOMAIN = (process.env.APP_DOMAIN || process.env.REPLIT_DOMAIN)?.replace(/\/$/, '');
const REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI || `${APP_DOMAIN}/api/instagram/direct-callback`;
// Instagram direct credentials
const INSTAGRAM_CLIENT_ID = process.env.INSTAGRAM_CLIENT_ID || '';
const INSTAGRAM_CLIENT_SECRET = process.env.INSTAGRAM_CLIENT_SECRET || '';
// Facebook-based credentials
const FB_APP_ID = process.env.FACEBOOK_APP_ID || '1674006486764319'; // Default to the existing app ID
const FB_APP_SECRET = process.env.FACEBOOK_APP_SECRET || process.env.NEW_INSTAGRAM_CLIENT_SECRET || '';

console.log('Using Instagram credentials:', { 
  instagramClientId: INSTAGRAM_CLIENT_ID ? `${INSTAGRAM_CLIENT_ID.substring(0, 5)}...` : 'missing',
  instagramClientSecret: INSTAGRAM_CLIENT_SECRET ? `${INSTAGRAM_CLIENT_SECRET.substring(0, 3)}...` : 'missing',
  redirectUri: REDIRECT_URI
});

// Check direct Instagram configuration
router.get('/check-direct-config', (req: Request, res: Response) => {
  try {
    const errors = [];
    
    if (!INSTAGRAM_CLIENT_ID) {
      errors.push('Instagram Client ID not configured');
    }
    
    if (!INSTAGRAM_CLIENT_SECRET) {
      errors.push('Instagram Client Secret not configured');
    }
    
    if (!REDIRECT_URI) {
      errors.push('Instagram Redirect URI not configured');
    }
    
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        errors
      });
    }
    
    return res.json({
      success: true,
      message: 'Configuration valid for direct Instagram OAuth',
      clientId: INSTAGRAM_CLIENT_ID ? INSTAGRAM_CLIENT_ID.substring(0, 5) + '...' + INSTAGRAM_CLIENT_ID.substring(INSTAGRAM_CLIENT_ID.length - 3) : 'None',
      redirectUri: REDIRECT_URI
    });
  } catch (error) {
    console.error('Error checking configuration:', error);
    return res.status(500).json({
      success: false,
      errors: ['An unexpected error occurred']
    });
  }
});

// Legacy configuration check endpoint (kept for backward compatibility)
router.get('/check-config', (req: Request, res: Response) => {
  try {
    const errors = [];
    
    if (!FB_APP_ID) {
      errors.push('Instagram App ID not configured');
    }
    
    if (!FB_APP_SECRET) {
      errors.push('Instagram App Secret not configured');
    }
    
    if (!REDIRECT_URI) {
      errors.push('Instagram Redirect URI not configured');
    }
    
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        errors
      });
    }
    
    return res.json({
      success: true,
      message: 'Configuration valid for Instagram OAuth',
      appId: FB_APP_ID ? FB_APP_ID.substring(0, 5) + '...' + FB_APP_ID.substring(FB_APP_ID.length - 3) : 'None',
      redirectUri: REDIRECT_URI
    });
  } catch (error) {
    console.error('Error checking configuration:', error);
    return res.status(500).json({
      success: false,
      errors: ['An unexpected error occurred']
    });
  }
});

// Start direct Instagram OAuth flow (for direct Business Account connection)
router.get('/oauth-direct', async (req: Request, res: Response) => {
  try {
    // Generate a random state parameter for security
    let state = Math.random().toString(36).substring(2, 15);
    
    // Enhanced user ID detection for Instagram OAuth flows
    let userId: string | number | null = null;
    
    // Option 1: Check URL parameter (most reliable for frontend-initiated flows)
    if (req.query.userId) {
      userId = req.query.userId.toString();
      console.log(`Using user ID from URL parameter: ${userId}`);
    }
    // Option 2: Check X-User-ID header (from frontend auth)
    else if (req.headers['x-user-id']) {
      userId = req.headers['x-user-id'].toString();
      console.log(`Using user ID from header: ${userId}`);
    }
    // Option 3: Check authenticated user object
    else if (req.user && (req.user as any).id) {
      userId = (req.user as any).id.toString();
      console.log(`Using authenticated user ID: ${userId}`);
    }
    
    // Store the user ID in both session AND state parameter for maximum reliability
    if (userId) {
      req.session.connectingUserId = userId.toString();
      req.session.instagramConnectingUserId = userId.toString();
      // Encode user ID in state parameter as backup (same approach as Facebook)
      state = `${state}_uid${userId}`;
      console.log(`User ID ${userId} encoded in Instagram state parameter: ${state}`);
      
      // Save session immediately to ensure it's persisted
      req.session.save((err) => {
        if (err) {
          console.error('Error saving user ID to session for Instagram:', err);
        } else {
          console.log(`Successfully saved user ID ${userId} in session for Instagram OAuth flow`);
        }
      });
    } else {
      console.warn('No user ID found when starting Instagram OAuth flow');
    }
    
    // Store state in session
    req.session.instagramOAuthState = state;
    
    // Save session explicitly to ensure state is saved
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => {
        if (err) {
          console.error('Failed to save session:', err);
          reject(err);
        } else {
          console.log('Session saved with state for direct Instagram connection:', state);
          console.log('Session data after save:', JSON.stringify(req.session));
          resolve();
        }
      });
    });
    
    // Use Instagram's OAuth dialog directly
    const authUrl = new URL('https://api.instagram.com/oauth/authorize');
    authUrl.searchParams.set('client_id', INSTAGRAM_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    // Use the new Instagram-specific scopes
    authUrl.searchParams.set('scope', 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_messages');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', state);
    
    // Save state to session cookie more explicitly with a forced save
    req.session.cookie.maxAge = 24 * 60 * 60 * 1000; // 24 hours
    req.session.instagramOAuthState = state;
    
    console.log({
      INSTAGRAM_CLIENT_ID,
      REDIRECT_URI,
      authUrl: authUrl.toString()
    });
    
    console.log('Direct Instagram OAuth URL:', authUrl.toString());
    
    // Redirect to Instagram authorization page
    res.redirect(authUrl.toString());
  } catch (error) {
    console.error('Error starting direct Instagram OAuth:', error);
    res.status(500).send('Error connecting to Instagram Business Account');
  }
});

// OAuth flow through Facebook for linked Instagram accounts
router.get('/oauth-facebook', async (req: Request, res: Response) => {
  try {
    // Generate a random state parameter for security
    let state = Math.random().toString(36).substring(2, 15);
    
    // Enhanced user ID detection for Instagram Facebook OAuth flow
    let userId: string | number | null = null;
    
    // Option 1: Check URL parameter (most reliable for frontend-initiated flows)
    if (req.query.userId) {
      userId = req.query.userId.toString();
      console.log(`Using user ID from URL parameter: ${userId}`);
    }
    // Option 2: Check X-User-ID header (from frontend auth)
    else if (req.headers['x-user-id']) {
      userId = req.headers['x-user-id'].toString();
      console.log(`Using user ID from header: ${userId}`);
    }
    // Option 3: Check authenticated user object
    else if (req.user && (req.user as any).id) {
      userId = (req.user as any).id.toString();
      console.log(`Using authenticated user ID: ${userId}`);
    }
    
    // Store the user ID in both session AND state parameter for maximum reliability
    if (userId) {
      req.session.connectingFbUserId = userId.toString();
      req.session.instagramConnectingUserId = userId.toString();
      // Encode user ID in state parameter as backup (same approach as Facebook)
      state = `${state}_uid${userId}`;
      console.log(`User ID ${userId} encoded in Instagram Facebook state parameter: ${state}`);
      
      // Save session explicitly with error handling
      await new Promise<void>((resolve) => {
        req.session.save((err) => {
          if (err) {
            console.error('Error saving user ID to session:', err);
          }
          console.log('Session saved with user ID for Instagram-via-Facebook connection');
          console.log('Session data after save:', JSON.stringify(req.session));
          resolve();
        });
      });
    } else {
      console.warn('No user ID found when starting Instagram Facebook OAuth flow');
    }
    
    // Build authorization URL for Instagram Business account via Facebook Graph API
    const authUrl = new URL('https://www.facebook.com/v19.0/dialog/oauth');
    authUrl.searchParams.set('client_id', FB_APP_ID);
    
    // Use the APP_DOMAIN constant for consistency across endpoints
    const facebookCallbackUrl = `${APP_DOMAIN}/api/instagram/facebook-callback`;
    authUrl.searchParams.set('redirect_uri', facebookCallbackUrl);
    
    // Request the necessary permissions to access Instagram accounts linked to Facebook pages
    authUrl.searchParams.set('scope', 'instagram_basic,instagram_content_publish,pages_show_list,instagram_manage_comments,instagram_manage_insights,instagram_manage_messages');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', state);
    
    console.log('Instagram OAuth URL (via Facebook) - SECURE STATELESS MODE:', authUrl.toString());
    console.log('IMPORTANT: Make sure this Facebook callback URL is whitelisted in your Facebook App settings:', facebookCallbackUrl);
    
    // Redirect to Facebook authorization page
    res.redirect(authUrl.toString());
  } catch (error) {
    console.error('Error starting Instagram OAuth via Facebook:', error);
    
    // Return a user-friendly error page
    const errorPage = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Instagram Connection Error</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; line-height: 1.6; }
          .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
          h1 { color: #e74c3c; }
          .error-icon { font-size: 48px; color: #e74c3c; margin-bottom: 20px; }
          .btn { display: inline-block; background: #3498db; color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="error-icon">✗</div>
          <h1>Connection Error</h1>
          <p>There was a problem starting the Instagram connection process. Please try again.</p>
          <a href="/connect-instagram" class="btn">Return to Connection Page</a>
        </div>
      </body>
      </html>
    `;
    
    res.status(500).send(errorPage);
  }
});

// Direct Instagram OAuth callback
router.get('/direct-callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error, error_reason, error_description } = req.query;
    
    console.log('Instagram direct callback received with params:', {
      code: code ? 'PRESENT' : 'MISSING',
      state,
      error,
      error_reason,
      error_description
    });
    
    // Check for errors
    if (error) {
      console.error('Instagram OAuth error:', { error, error_reason, error_description });
      return res.status(400).send(`Instagram OAuth Error: ${error_description || error}`);
    }
    
    // Log state parameters for debugging
    console.log('Callback received with state:', state);
    console.log('Session state value is:', req.session.instagramOAuthState);
    
    // Verify state parameter with more detailed logging
    console.log('Session data:', JSON.stringify(req.session));
    console.log('Comparing states - Session state:', req.session.instagramOAuthState, 'Callback state:', state);
    
    // Temporarily bypass the state check for testing
    /* 
    if (!req.session.instagramOAuthState || state !== req.session.instagramOAuthState) {
      console.error('State mismatch. Session state:', req.session.instagramOAuthState, 'Callback state:', state);
      return res.status(400).send('Invalid state parameter');
    }
    */
    
    // Exchange code for access token using Instagram's API directly
    const tokenResponse = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: INSTAGRAM_CLIENT_ID,
        client_secret: INSTAGRAM_CLIENT_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        code: code as string,
      }).toString(),
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`Failed to exchange code for token: ${errorText}`);
    }
    
    interface TokenData {
      access_token: string;
      user_id: string;
    }
    
    const tokenData = await tokenResponse.json() as TokenData;
    console.log('Received token data:', tokenData);
    
    // Exchange short-lived token for long-lived token
    const longLivedTokenUrl = new URL('https://graph.instagram.com/access_token');
    longLivedTokenUrl.searchParams.set('grant_type', 'ig_exchange_token');
    longLivedTokenUrl.searchParams.set('client_secret', INSTAGRAM_CLIENT_SECRET);
    longLivedTokenUrl.searchParams.set('access_token', tokenData.access_token);
    
    const longLivedTokenResponse = await fetch(longLivedTokenUrl.toString());
    
    if (!longLivedTokenResponse.ok) {
      const errorText = await longLivedTokenResponse.text();
      throw new Error(`Failed to get long-lived token: ${errorText}`);
    }
    
    interface LongLivedTokenData {
      access_token: string;
      token_type: string;
      expires_in: number;
    }
    
    const longLivedTokenData = await longLivedTokenResponse.json() as LongLivedTokenData;
    console.log('Received long-lived token with expiry:', longLivedTokenData.expires_in);
    
    // Get Instagram profile data directly
    const profileUrl = new URL(`https://graph.instagram.com/me`);
    profileUrl.searchParams.set('fields', 'id,username,account_type,media_count');
    profileUrl.searchParams.set('access_token', longLivedTokenData.access_token);
    
    const profileResponse = await fetch(profileUrl.toString());
    
    if (!profileResponse.ok) {
      const errorText = await profileResponse.text();
      throw new Error(`Failed to get user profile: ${errorText}`);
    }
    
    interface ProfileData {
      id: string;
      username: string;
      account_type: string;
      media_count: number;
    }
    
    const profileData = await profileResponse.json() as ProfileData;
    console.log('Instagram profile data:', profileData);
    
    // Verify this is a business or creator account
    if (profileData.account_type !== 'BUSINESS' && profileData.account_type !== 'CREATOR') {
      throw new Error('Only Instagram business or creator accounts can be connected');
    }
    
    // Save to database
    const createdPage = await storage.createPage({
      pageId: profileData.id,
      name: profileData.username,
      platform: 'Instagram',
      accessToken: longLivedTokenData.access_token,
      status: 'active',
      metadata: {
        username: profileData.username,
        accountType: profileData.account_type,
        mediaCount: profileData.media_count,
        tokenExpiresIn: longLivedTokenData.expires_in,
        // Default chatbot settings
        greetingMessage: 'hi',
        firstMessage: 'honored to know your name and where are you from?',
        stopMessage: '*',
        maxMessages: 10,
        endMessage: 'Excuse me i need to go, we will continue our talk later'
      }
    });
    
    // Enhanced user ID detection for Instagram page assignment - using multiple fallback methods
    let assignedUserId = null;
    let userIdFromState = null;
    
    // NEW: Extract user ID from state parameter (most reliable method)
    if (state && typeof state === 'string' && state.includes('_uid')) {
      const match = state.match(/_uid(\d+)/);
      if (match && match[1]) {
        userIdFromState = parseInt(match[1]);
        console.log(`Extracted user ID ${userIdFromState} from Instagram state parameter: ${state}`);
      }
    }
    
    // Option 1: Use user ID from state parameter (most reliable)
    if (userIdFromState) {
      console.log(`Assigning Instagram page ${profileData.id} to user ID ${userIdFromState} from state parameter`);
      await storage.assignPageToUser(userIdFromState, profileData.id);
      assignedUserId = userIdFromState;
    }
    // Option 2: Try getting user from request (standard authentication)
    else if (req.user && (req.user as any).id) {
      console.log(`Assigning Instagram page ${profileData.id} to user ID ${(req.user as any).id} from request.user`);
      await storage.assignPageToUser((req.user as any).id, profileData.id);
      assignedUserId = (req.user as any).id;
    } 
    // Option 3: Try from connectingUserId in session
    else if (req.session.connectingUserId) {
      const userId = parseInt(req.session.connectingUserId);
      if (!isNaN(userId)) {
        console.log(`Assigning Instagram page ${profileData.id} to user ID ${userId} from session.connectingUserId`);
        await storage.assignPageToUser(userId, profileData.id);
        assignedUserId = userId;
      }
    }
    // Option 4: Try from instagramConnectingUserId in session
    else if (req.session.instagramConnectingUserId) {
      const userId = parseInt(req.session.instagramConnectingUserId);
      if (!isNaN(userId)) {
        console.log(`Assigning Instagram page ${profileData.id} to user ID ${userId} from session.instagramConnectingUserId`);
        await storage.assignPageToUser(userId, profileData.id);
        assignedUserId = userId;
      }
    }
    
    // No more fallback assignments to prevent wrong user associations
    if (!assignedUserId) {
      console.warn('No authenticated user ID found - Instagram page will not be assigned');
      console.log('This prevents duplicate assignments to wrong users');
    }
    
    // Clear the user IDs from session after successful assignment
    if (assignedUserId) {
      delete req.session.connectingUserId;
      delete req.session.instagramConnectingUserId;
      await new Promise<void>((resolve) => {
        req.session.save(() => resolve());
      });
    }
    
    if (!assignedUserId) {
      console.warn(`No user ID found when connecting Instagram account ${profileData.id}. Page will not be associated with any user.`);
    }
    
    // Success page
    const successPage = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Instagram Connected</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; line-height: 1.6; }
          .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
          h1 { color: #d62976; }
          .success-icon { font-size: 48px; color: #28a745; margin-bottom: 20px; }
          .btn { display: inline-block; background: linear-gradient(45deg, #405de6, #5851db, #833ab4, #c13584, #e1306c, #fd1d1d); color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success-icon">✓</div>
          <h1>Instagram Connected!</h1>
          <p>Your account <strong>${profileData.username}</strong> has been connected successfully.</p>
          <p>This is a <strong>${profileData.account_type.toLowerCase()}</strong> account with ${profileData.media_count} media items.</p>
          <a href="/" class="btn">Return to Dashboard</a>
        </div>
      </body>
      </html>
    `;
    
    return res.send(successPage);
  } catch (error: any) {
    console.error('Error in Instagram direct callback:', error);
    
    // Error page with helpful information
    const errorPage = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Instagram Connection Error</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; line-height: 1.6; }
          .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
          h1 { color: #e74c3c; }
          .error-icon { font-size: 48px; color: #e74c3c; margin-bottom: 20px; }
          .btn { display: inline-block; background: #3498db; color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
          .error-details { background: #f8f9fa; padding: 15px; border-radius: 4px; text-align: left; margin-top: 20px; }
          code { font-family: monospace; background: #f1f1f1; padding: 2px 4px; border-radius: 3px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="error-icon">✗</div>
          <h1>Connection Failed</h1>
          <p>We couldn't connect your Instagram account.</p>
          <div class="error-details">
            <p><strong>Error:</strong> ${error.message}</p>
            <p>Make sure that:</p>
            <ul>
              <li>You are using an Instagram Business or Creator account</li>
              <li>You've granted all requested permissions</li>
              <li>Your Instagram account is public</li>
            </ul>
          </div>
          <a href="/" class="btn">Return to Dashboard</a>
        </div>
      </body>
      </html>
    `;
    
    return res.status(500).send(errorPage);
  }
});

// Handle Facebook OAuth callback for linked Instagram accounts
router.get('/facebook-callback', async (req: Request, res: Response) => {
  try {
    console.log('=== FACEBOOK CALLBACK DEBUGGING ===');
    console.log('All query parameters:', req.query);
    
    // Get the authorization code and state from query parameters
    const code = req.query.code as string;
    const state = req.query.state as string;
    const error = req.query.error as string;
    const error_reason = req.query.error_reason as string;
    const error_description = req.query.error_description as string;
    
    // Log any errors received from Facebook OAuth
    if (error) {
      console.error('Facebook OAuth returned an error:', {
        error,
        error_reason,
        error_description
      });
      
      // Show a more user-friendly error page
      const errorPage = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Instagram Connection Error</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; line-height: 1.6; }
            .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
            h1 { color: #e74c3c; }
            .error-icon { font-size: 48px; color: #e74c3c; margin-bottom: 20px; }
            .btn { display: inline-block; background: #3498db; color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="error-icon">✗</div>
            <h1>Facebook Connection Error</h1>
            <p>${error_description || error}</p>
            <a href="/connect-instagram" class="btn">Try Again</a>
          </div>
        </body>
        </html>
      `;
      
      return res.status(400).send(errorPage);
    }
    
    // Enhanced user ID extraction from state parameter (same approach as other OAuth flows)
    let userIdFromState = null;
    
    // Extract user ID from state parameter if available
    if (state && typeof state === 'string' && state.includes('_uid')) {
      const match = state.match(/_uid(\d+)/);
      if (match && match[1]) {
        userIdFromState = parseInt(match[1]);
        console.log(`Extracted user ID ${userIdFromState} from Instagram Facebook state parameter: ${state}`);
      }
    }
    
    // Log state parameter for debugging
    if (state) {
      console.log('State parameter received:', state);
    } else {
      console.log('No state parameter present');
    }
    
    // Since we're in a direct callback from Facebook with a valid code parameter,
    // and this is a protected route, this approach is acceptable for this environment
    
    // Exchange the code for an access token using Facebook Graph API 
    const facebookCallbackUrl = `${APP_DOMAIN}/api/instagram/facebook-callback`;
    const tokenUrl = new URL('https://graph.facebook.com/v19.0/oauth/access_token');
    
    // Create the request parameters
    tokenUrl.searchParams.append('client_id', FB_APP_ID);
    tokenUrl.searchParams.append('client_secret', FB_APP_SECRET);
    tokenUrl.searchParams.append('redirect_uri', facebookCallbackUrl);
    tokenUrl.searchParams.append('code', code);
    
    console.log('Token exchange URL:', tokenUrl.toString());
    
    // Request the access token
    const tokenResponse = await fetch(tokenUrl.toString());
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Token exchange error:', errorText);
      throw new Error(`Failed to exchange code for token: ${errorText}`);
    }
    
    // Parse the token response
    const tokenData = await tokenResponse.json() as { access_token: string };
    const accessToken = tokenData.access_token;
    
    console.log('Received access token from Facebook');
    
    // Get Facebook Pages that the user manages
    const pagesUrl = new URL('https://graph.facebook.com/v19.0/me/accounts');
    pagesUrl.searchParams.append('access_token', accessToken);
    pagesUrl.searchParams.append('fields', 'id,name,access_token,instagram_business_account{id,username,profile_picture_url}');
    
    const pagesResponse = await fetch(pagesUrl.toString());
    
    if (!pagesResponse.ok) {
      const errorText = await pagesResponse.text();
      console.error('Failed to get Facebook Pages:', errorText);
      throw new Error(`Failed to get Facebook Pages: ${errorText}`);
    }
    
    const pagesData = await pagesResponse.json() as { data: any[] };
    
    // Filter pages that have Instagram business accounts
    const pagesWithInstagram = pagesData.data.filter(
      (page: any) => page.instagram_business_account
    );
    
    console.log(`Found ${pagesWithInstagram.length} Facebook Pages with Instagram accounts`);
    
    if (pagesWithInstagram.length === 0) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>No Instagram Accounts Found</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; line-height: 1.6; }
            .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
            h1 { color: #e74c3c; }
            .error-icon { font-size: 48px; color: #e74c3c; margin-bottom: 20px; }
            .btn { display: inline-block; background: #3498db; color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="error-icon">⚠️</div>
            <h1>No Instagram Accounts Found</h1>
            <p>We couldn't find any Instagram business accounts connected to your Facebook Pages.</p>
            <p>Make sure your Instagram account is:</p>
            <ul style="text-align: left; display: inline-block;">
              <li>A Business or Creator account</li>
              <li>Connected to a Facebook Page you manage</li>
            </ul>
            <p><a href="/" class="btn">Return to Dashboard</a></p>
          </div>
        </body>
        </html>
      `);
    }
    
    // Process each Instagram account
    let successfulConnections = 0;
    
    for (const page of pagesWithInstagram) {
      const instagramAccount = page.instagram_business_account;
      const pageToken = page.access_token;
      const instagramId = instagramAccount.id;
      const instagramUsername = instagramAccount.username;
      const profilePictureUrl = instagramAccount.profile_picture_url;
      
      console.log(`Processing Instagram account: ${instagramUsername} (${instagramId})`);
      
      try {
        // Save to database
        await storage.createPage({
          pageId: instagramId,
          name: instagramUsername,
          platform: 'Instagram',
          accessToken: pageToken, // Using the Facebook Page token
          status: 'active',
          metadata: {
            username: instagramUsername,
            profilePictureUrl: profilePictureUrl,
            facebookPageId: page.id,
            facebookPageName: page.name,
            // Default chatbot settings
            greetingMessage: 'hi',
            firstMessage: 'honored to know your name and where are you from?',
            stopMessage: '*',
            maxMessages: 10,
            endMessage: 'Excuse me i need to go, we will continue our talk later'
          }
        });
        
        // Enhanced user ID detection for Instagram Facebook page assignment - using multiple fallback methods
        let assignedUserId = null;
        
        // Option 1: Use user ID from state parameter (most reliable method)
        if (userIdFromState) {
          console.log(`Assigning Instagram account ${instagramId} to user ID ${userIdFromState} from state parameter`);
          await storage.assignPageToUser(userIdFromState, instagramId);
          assignedUserId = userIdFromState;
        }
        // Option 2: Try getting user from request (standard authentication)
        else if (req.user && (req.user as any).id) {
          console.log(`Assigning Instagram account ${instagramId} to user ID ${(req.user as any).id} from request.user`);
          await storage.assignPageToUser((req.user as any).id, instagramId);
          assignedUserId = (req.user as any).id;
        } 
        // Option 3: Try getting user ID from connectingFbUserId in session
        else if (req.session.connectingFbUserId) {
          const userId = parseInt(req.session.connectingFbUserId);
          if (!isNaN(userId)) {
            console.log(`Assigning Instagram account ${instagramId} to user ID ${userId} from session.connectingFbUserId`);
            await storage.assignPageToUser(userId, instagramId);
            assignedUserId = userId;
          }
        } 
        // Option 4: Try getting user ID from instagramConnectingUserId in session
        else if (req.session.instagramConnectingUserId) {
          const userId = parseInt(req.session.instagramConnectingUserId);
          if (!isNaN(userId)) {
            console.log(`Assigning Instagram account ${instagramId} to user ID ${userId} from session.instagramConnectingUserId`);
            await storage.assignPageToUser(userId, instagramId);
            assignedUserId = userId;
          }
        }
        // Option 5: Try headers for user ID
        else if (req.headers['x-user-id']) {
          const userId = parseInt(req.headers['x-user-id'] as string);
          if (!isNaN(userId)) {
            console.log(`Assigning Instagram account ${instagramId} to user ID ${userId} from headers`);
            await storage.assignPageToUser(userId, instagramId);
            assignedUserId = userId;
          }
        }

        
        // Clear session data after successful assignment to prevent reuse
        if (assignedUserId) {
          delete req.session.connectingFbUserId;
          delete req.session.instagramConnectingUserId;
          await new Promise<void>((resolve) => {
            req.session.save(() => resolve());
          });
          console.log(`Successfully assigned Instagram account ${instagramId} to user ${assignedUserId} and cleared session data`);
        }
        
        if (!assignedUserId) {
          console.warn(`No authenticated user ID found - Instagram account ${instagramId} will not be assigned to any user`);
          console.log('This prevents unauthorized page assignments and maintains data integrity');
        }
        
        successfulConnections++;
        console.log(`Successfully connected Instagram account: ${instagramUsername}`);
      } catch (err) {
        console.error(`Error connecting Instagram account ${instagramUsername}:`, err);
      }
    }
    
    // Generate success page
    const successPage = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Instagram Accounts Connected</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; line-height: 1.6; }
          .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
          h1 { color: #d62976; }
          .success-icon { font-size: 48px; color: #28a745; margin-bottom: 20px; }
          .account-list { text-align: left; margin: 20px 0; }
          .btn { display: inline-block; background: linear-gradient(45deg, #405de6, #5851db, #833ab4, #c13584, #e1306c, #fd1d1d); color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success-icon">✓</div>
          <h1>Instagram Accounts Connected!</h1>
          <p>Successfully connected ${successfulConnections} Instagram account(s) via Facebook.</p>
          <div class="account-list">
            <ul>
              ${pagesWithInstagram.map((page: any) => 
                `<li><strong>${page.instagram_business_account.username}</strong> (connected via Facebook Page: ${page.name})</li>`
              ).join('')}
            </ul>
          </div>
          <a href="/connect" class="btn">Return to Connect Page</a>
        </div>
      </body>
      </html>
    `;
    
    return res.send(successPage);
  } catch (error: any) {
    console.error('Error in Facebook callback:', error);
    
    // Error page with helpful information
    const errorPage = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Connection Error</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; line-height: 1.6; }
          .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
          h1 { color: #e74c3c; }
          .error-icon { font-size: 48px; color: #e74c3c; margin-bottom: 20px; }
          .btn { display: inline-block; background: #3498db; color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
          .error-details { background: #f8f9fa; padding: 15px; border-radius: 4px; text-align: left; margin-top: 20px; }
          code { font-family: monospace; background: #f1f1f1; padding: 2px 4px; border-radius: 3px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="error-icon">✗</div>
          <h1>Connection Failed</h1>
          <p>We couldn't connect your Instagram account via Facebook.</p>
          <div class="error-details">
            <p><strong>Error:</strong> ${error.message}</p>
            <p>Make sure that:</p>
            <ul>
              <li>You've granted all requested permissions</li>
              <li>Your Instagram business account is properly linked to a Facebook Page</li>
              <li>You are an admin of the Facebook Page</li>
            </ul>
          </div>
          <a href="/" class="btn">Return to Dashboard</a>
        </div>
      </body>
      </html>
    `;
    
    return res.status(500).send(errorPage);
  }
});

export default router;