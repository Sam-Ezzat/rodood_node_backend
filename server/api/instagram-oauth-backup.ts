import { Router, Request, Response } from 'express';
import { storage } from '../storage';
import fetch from 'node-fetch';
import 'express-session';

// Extend the Express session interface to add our own properties
declare module 'express-session' {
  interface SessionData {
    instagramOAuthState?: string;
    instagramPages?: Array<{id: string, name: string, access_token: string}>;
    isDirectInstagramConnection?: boolean;
    instagramUserName?: string;
    instagramUserId?: string;
  }
}

// Create a router for Instagram OAuth
const router = Router();

// Debug endpoint to show Instagram configuration
router.get('/debug-config', (req: Request, res: Response) => {
  // Only available to admin users for security
  if (!req.header('X-User-ID') || req.header('X-User-ID') !== '1') {
    return res.status(403).json({ error: 'Unauthorized. Admin access required.' });
  }
  
  const config = {
    INSTAGRAM_CLIENT_ID: process.env.INSTAGRAM_CLIENT_ID ? `${process.env.INSTAGRAM_CLIENT_ID.substring(0, 4)}...${process.env.INSTAGRAM_CLIENT_ID.substring(process.env.INSTAGRAM_CLIENT_ID.length - 4)}` : 'Not set',
    APP_ID: process.env.APP_ID ? `${process.env.APP_ID.substring(0, 4)}...${process.env.APP_ID.substring(process.env.APP_ID.length - 4)}` : 'Not set',
    EFFECTIVE_APP_ID: (() => {
      const effectiveId = process.env.INSTAGRAM_CLIENT_ID || process.env.APP_ID;
      return effectiveId 
        ? `${effectiveId.substring(0, 4)}...${effectiveId.substring(effectiveId.length - 4)}` 
        : 'Not set';
    })(),
    INSTAGRAM_CLIENT_SECRET_SET: process.env.INSTAGRAM_CLIENT_SECRET ? 'Yes' : 'No',
    INSTAGRAM_REDIRECT_URI: process.env.INSTAGRAM_REDIRECT_URI || 'Not set',
    INSTAGRAM_DIRECT_REDIRECT_URI: `${APP_DOMAIN}/api/instagram/direct-callback`,
    APP_DOMAIN: APP_DOMAIN,
  };
  
  return res.json(config);
});

// Endpoint to check if Instagram is properly configured
router.get('/check-config', (req: Request, res: Response) => {
  // Check if Instagram app is properly configured
  const configErrors = [];
  
  // Get App ID - either from INSTAGRAM_CLIENT_ID or APP_ID
  const appId = process.env.INSTAGRAM_CLIENT_ID || process.env.APP_ID || '';
  
  if (!appId || appId.trim() === '') {
    configErrors.push('Instagram App ID is not configured (neither INSTAGRAM_CLIENT_ID nor APP_ID is set)');
  }
  
  if (!INSTAGRAM_CLIENT_SECRET || INSTAGRAM_CLIENT_SECRET.trim() === '') {
    configErrors.push('Instagram Client Secret is not configured');
  }
  
  // Check if the Instagram client ID looks valid (typically a long numeric string)
  if (!/^\d+$/.test(appId)) {
    configErrors.push('Instagram App ID appears to be invalid (should be numeric)');
  }
  
  // If we have the API URL, check if it contains 'instagram.com/' which indicates 
  // it's an Instagram profile URL and not a properly configured redirect URI
  if (process.env.INSTAGRAM_REDIRECT_URI?.includes('instagram.com/')) {
    configErrors.push('Instagram Redirect URI is set to an Instagram profile URL, not a callback URL');
  }
  
  if (configErrors.length > 0) {
    return res.json({
      success: false,
      message: 'Instagram app is not properly configured. The direct connection method requires a valid Instagram app setup in the Meta Developer Portal.',
      errors: configErrors,
      useFacebookAlternative: true
    });
  }
  
  // If we get here, the configuration looks valid (but may still be rejected by Instagram)
  return res.json({
    success: true,
    message: 'Instagram configuration appears valid',
  });
});

// Instagram OAuth configuration
// Use the dedicated Instagram credentials or fall back to APP_ID if set
const INSTAGRAM_CLIENT_ID = process.env.INSTAGRAM_CLIENT_ID || process.env.APP_ID || '';
const INSTAGRAM_CLIENT_SECRET = process.env.INSTAGRAM_CLIENT_SECRET || '';
// Get the domain for OAuth redirects - works for both development and production
const APP_DOMAIN = (process.env.APP_DOMAIN || process.env.REPLIT_DOMAIN)?.replace(/\/$/, '');

// The redirect URI must match exactly with what's configured in the Meta Developer Console
// Check if Instagram environment variables are set properly
console.log('=== INSTAGRAM ENVIRONMENT DEBUGGING ===');
console.log('Original INSTAGRAM_REDIRECT_URI:', process.env.INSTAGRAM_REDIRECT_URI);
console.log('Original INSTAGRAM_CLIENT_ID:', process.env.INSTAGRAM_CLIENT_ID ? 'Set (not showing for security)' : 'Not set');
console.log('Original INSTAGRAM_CLIENT_SECRET:', process.env.INSTAGRAM_CLIENT_SECRET ? 'Set (not showing for security)' : 'Not set');
console.log('APP_DOMAIN:', APP_DOMAIN);

// If INSTAGRAM_REDIRECT_URI is not set properly (e.g., it's a profile URL), construct it from APP_DOMAIN
const INSTAGRAM_REDIRECT_URI = 
  process.env.INSTAGRAM_REDIRECT_URI && 
  !process.env.INSTAGRAM_REDIRECT_URI.includes('instagram.com/') 
    ? process.env.INSTAGRAM_REDIRECT_URI 
    : `${APP_DOMAIN}/api/instagram/oauth-callback`;

// Direct OAuth callback URL
const INSTAGRAM_DIRECT_REDIRECT_URI = `${APP_DOMAIN}/api/instagram/direct-callback`;

console.log('Final INSTAGRAM_REDIRECT_URI:', INSTAGRAM_REDIRECT_URI);
console.log('INSTAGRAM_DIRECT_REDIRECT_URI:', INSTAGRAM_DIRECT_REDIRECT_URI);
console.log('=======================================');

// OAuth initialization endpoint - redirects user to Instagram authorization page
router.get('/oauth-init', (req: Request, res: Response) => {
  // Create a cryptographically secure state parameter to prevent CSRF attacks
  const state = Math.random().toString(36).substring(2, 15);
  
  // Store state in session to verify on callback
  req.session.instagramOAuthState = state;
  
  // Parameters needed for authorization
  // Get App ID - either from INSTAGRAM_CLIENT_ID or APP_ID
  const clientId = process.env.INSTAGRAM_CLIENT_ID || process.env.APP_ID || '';
  
  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('redirect_uri', INSTAGRAM_REDIRECT_URI);
  params.append('state', state);
  // Use Instagram-specific permissions
  params.append('scope', 'instagram_basic,instagram_content_publish,instagram_manage_comments,instagram_manage_insights,instagram_manage_messages');
  params.append('response_type', 'code');
  
  // Log the state for debugging
  console.log(`Instagram OAuth state created: ${state}`);
  console.log(`Instagram OAuth redirect URL: ${INSTAGRAM_REDIRECT_URI}`);
  
  // Redirect to Instagram for authorization
  res.redirect(`https://api.instagram.com/oauth/authorize?${params.toString()}`);
});

// Direct Instagram OAuth - streamlined connection directly to Instagram
router.get('/direct-oauth', (req: Request, res: Response) => {
  try {
    // Get client ID from either INSTAGRAM_CLIENT_ID or APP_ID environment variables 
    const clientId = INSTAGRAM_CLIENT_ID;
    
    // Validate Instagram client ID is properly configured
    if (!clientId || clientId.trim() === '') {
      throw new Error('Instagram App ID is not configured. Please check your environment variables.');
    }
    
    // Create a cryptographically secure state parameter to prevent CSRF attacks
    const state = Math.random().toString(36).substring(2, 15);
    
    // Store direct connection flag in session
    req.session.isDirectInstagramConnection = true;
    req.session.instagramOAuthState = state;
    
    // Parameters needed for authorization using Facebook's OAuth for Instagram Business
    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('redirect_uri', INSTAGRAM_DIRECT_REDIRECT_URI);
    params.append('state', state);
    // Permissions required for Instagram Business API - note the addition of pages_show_list
    // Required per: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started
    params.append('scope', 'instagram_basic,instagram_manage_messages,pages_show_list');
    params.append('response_type', 'code');
    
    // Enhanced debugging logs
    console.log('=== DIRECT INSTAGRAM BUSINESS OAUTH DEBUGGING ===');
    console.log(`Client ID: ${clientId}`);
    console.log(`Redirect URI: ${INSTAGRAM_DIRECT_REDIRECT_URI}`);
    console.log(`Generated state: ${state}`);
    console.log(`Full auth URL: https://www.facebook.com/dialog/oauth?${params.toString()}`);
    console.log('=======================================');
    
    // Use Facebook OAuth flow for Instagram Business account login
    // Per docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
    res.redirect(`https://www.facebook.com/dialog/oauth?${params.toString()}`);
  } catch (error: any) {
    // Render a user-friendly error page
    console.error('Instagram OAuth error:', error);
    
    const errorPage = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Instagram Connection Error</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; padding: 20px; max-width: 600px; margin: 0 auto; color: #333; }
          h1 { color: #d62976; }
          .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .steps { margin: 20px 0; padding-left: 20px; }
          .btn { display: inline-block; background: linear-gradient(45deg, #405de6, #5851db, #833ab4, #c13584, #e1306c, #fd1d1d); color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
          pre { background: #f6f8fa; padding: 10px; border-radius: 4px; overflow-x: auto; }
          .message { background: #fff8e1; border-left: 4px solid #ffd54f; padding: 10px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Instagram Connection Error</h1>
          <p>There was an error connecting to Instagram. This feature requires proper Instagram App configuration in the Meta Developer Portal.</p>
          
          <div class="message">
            <p><strong>Error:</strong> ${error.message || 'Invalid Instagram application configuration'}</p>
          </div>
          
          <h3>Common issues:</h3>
          <ul>
            <li>Instagram Client ID is invalid or not properly configured</li>
            <li>The redirect URI is not properly registered in the Meta Developer Portal</li>
            <li>The Instagram app hasn't been fully set up or approved by Meta</li>
          </ul>
          
          <p><strong>Alternative:</strong> Try using the "Connect via Facebook" option instead, which uses a different authentication flow.</p>
          
          <a href="/connect" class="btn">Return to Connection Page</a>
        </div>
      </body>
      </html>
    `;
    
    res.status(400).send(errorPage);
  }
});

// OAuth callback endpoint - where Instagram redirects after user authorization
router.get('/oauth-callback', async (req: Request, res: Response) => {
  try {
    // Get the authorization code and state from query parameters
    const code = req.query.code as string;
    const state = req.query.state as string;
    
    // Validate state to prevent CSRF attacks
    if (state !== req.session.instagramOAuthState) {
      console.warn('Instagram OAuth state mismatch. Expected:', req.session.instagramOAuthState, 'Received:', state);
      return res.status(400).send('Invalid OAuth state. Possible CSRF attack or session expired.');
    }
    
    // Log receipt of OAuth callback
    console.log('Received Instagram OAuth callback with code, proceeding to token exchange');
    
    // The redirect URI must match exactly with what was sent in the authorization request
    console.log('Using Instagram OAuth callback URL:', INSTAGRAM_REDIRECT_URI);
    
    // Exchange the code for an access token using Instagram API
    // Get App ID - either from INSTAGRAM_CLIENT_ID or APP_ID
    const clientId = process.env.INSTAGRAM_CLIENT_ID || process.env.APP_ID || '';
    
    const tokenResponse = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: INSTAGRAM_CLIENT_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: INSTAGRAM_REDIRECT_URI,
        code: code
      }).toString()
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`Failed to exchange code for token: ${errorText}`);
    }
    
    const tokenData = await tokenResponse.json() as { access_token: string, user_id: string };
    const accessToken = tokenData.access_token;
    const userId = tokenData.user_id;
    
    // Get a long-lived token that lasts for 60 days
    const longLivedTokenResponse = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${INSTAGRAM_CLIENT_SECRET}&access_token=${accessToken}`);
    
    if (!longLivedTokenResponse.ok) {
      const errorText = await longLivedTokenResponse.text();
      throw new Error(`Failed to exchange for long-lived token: ${errorText}`);
    }
    
    const longLivedTokenData = await longLivedTokenResponse.json() as { access_token: string, expires_in: number };
    const longLivedToken = longLivedTokenData.access_token;
    
    // Get Instagram user profile info using the token
    const userProfileResponse = await fetch(`https://graph.instagram.com/me?fields=id,username,account_type&access_token=${longLivedToken}`);
    
    if (!userProfileResponse.ok) {
      const errorText = await userProfileResponse.text();
      throw new Error(`Failed to fetch Instagram user profile: ${errorText}`);
    }
    
    const userProfile = await userProfileResponse.json() as { 
      id: string, 
      username: string,
      account_type?: string
    };
    
    console.log('Instagram user profile:', userProfile);
    
    // Store the Instagram account details directly since we're handling Instagram as a separate app now
    const instagramAccount = {
      id: userProfile.id,
      name: userProfile.username,
      accessToken: longLivedToken,
      accountType: userProfile.account_type || 'BUSINESS'
    };
    
    // Store user info in session
    req.session.instagramUserName = userProfile.username;
    req.session.instagramUserId = userProfile.id;
    
    try {
      // Check if Instagram account already exists in our database
      const existingPage = await storage.getPageByPageId(instagramAccount.id);
      
      if (!existingPage) {
        // Add the Instagram account to our database
        await storage.createPage({
          name: instagramAccount.name,
          pageId: instagramAccount.id,
          platform: 'Instagram',
          accessToken: instagramAccount.accessToken,
          status: 'active'
        });
        
        console.log(`Added new Instagram account: ${instagramAccount.name} (${instagramAccount.id})`);
      } else {
        // Update existing Instagram account
        await storage.updatePage(existingPage.pageId, {
          accessToken: instagramAccount.accessToken,
          status: 'active'
        });
        
        console.log(`Updated existing Instagram account: ${instagramAccount.name} (${instagramAccount.id})`);
      }
      
      // Redirect to dashboard with success message
      return res.redirect('/?instagramSuccess=true');
    } catch (error) {
      console.error('Error adding Instagram account to database:', error);
      throw error;
    }
    
  } catch (error: any) {
    console.error('Instagram OAuth callback error:', error);
    res.status(500).send(`Instagram OAuth Error: ${error.message}`);
  }
});

// Endpoint to get all available Instagram pages
router.get('/all-pages', async (req: Request, res: Response) => {
  try {
    const allPages = await storage.getAllPages();
    // Filter to only Instagram platform pages
    const instagramPages = allPages.filter(page => page.platform === 'Instagram');
    res.json({ success: true, pages: instagramPages });
  } catch (error: any) {
    console.error('Error retrieving Instagram pages:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Direct Instagram OAuth callback - handles direct Instagram connections
router.get('/direct-callback', async (req: Request, res: Response) => {
  try {
    // Get all query parameters for debugging
    console.log('=== DIRECT INSTAGRAM CALLBACK DEBUGGING ===');
    console.log('All query parameters:', req.query);
    
    // Get the authorization code and state from query parameters
    const code = req.query.code as string;
    const state = req.query.state as string;
    const error = req.query.error as string;
    const error_reason = req.query.error_reason as string;
    const error_description = req.query.error_description as string;
    
    // Log any errors received from Instagram
    if (error) {
      console.error('Instagram returned an error:', {
        error,
        error_reason,
        error_description
      });
      return res.status(400).send(`Instagram Error: ${error_description || error}`);
    }
    
    // Validate required parameters
    if (!code) {
      console.error('No authorization code received from Instagram');
      return res.status(400).send('No authorization code received from Instagram.');
    }
    
    if (!state) {
      console.error('No state parameter received from Instagram');
      return res.status(400).send('No state parameter received from Instagram.');
    }
    
    // Validate state to prevent CSRF attacks
    console.log('Session state:', req.session.instagramOAuthState);
    console.log('Received state:', state);
    
    if (state !== req.session.instagramOAuthState) {
      console.warn('Instagram OAuth state mismatch. Expected:', req.session.instagramOAuthState, 'Received:', state);
      return res.status(400).send('Invalid OAuth state. Possible CSRF attack or session expired.');
    }
    
    // Log receipt of OAuth callback
    console.log('Received Direct Instagram OAuth callback with code, proceeding to token exchange');
    console.log('=======================================');
    
    // Exchange the code for an access token using Instagram API
    console.log('=== TOKEN EXCHANGE DEBUGGING ===');
    // Get App ID - either from INSTAGRAM_CLIENT_ID or APP_ID
    const clientId = process.env.INSTAGRAM_CLIENT_ID || process.env.APP_ID || '';
    
    const tokenRequestBody = new URLSearchParams({
      client_id: clientId,
      client_secret: INSTAGRAM_CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: INSTAGRAM_DIRECT_REDIRECT_URI,
      code: code
    }).toString();
    
    console.log('Token exchange request params:', {
      url: 'https://graph.facebook.com/v18.0/oauth/access_token', // Using Facebook Graph API for Business Login
      client_id: INSTAGRAM_CLIENT_ID,
      redirect_uri: INSTAGRAM_DIRECT_REDIRECT_URI,
      code_length: code.length
    });
    
    // For Business Login, use Facebook's Graph API instead of Instagram's API
    // Per docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
    const tokenUrl = new URL('https://graph.facebook.com/v18.0/oauth/access_token');
    tokenUrl.searchParams.append('client_id', INSTAGRAM_CLIENT_ID);
    tokenUrl.searchParams.append('client_secret', INSTAGRAM_CLIENT_SECRET);
    tokenUrl.searchParams.append('redirect_uri', INSTAGRAM_DIRECT_REDIRECT_URI);
    tokenUrl.searchParams.append('code', code);
    
    console.log(`Token exchange URL: ${tokenUrl.toString().replace(INSTAGRAM_CLIENT_SECRET, '****')}`);
    
    const tokenResponse = await fetch(tokenUrl.toString(), {
      method: 'GET', // Facebook uses GET for this endpoint (different from Instagram's POST)
      headers: {
        'Accept': 'application/json'
      }
    });
    
    // Handle token response errors with user-friendly messages
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Token exchange error:', {
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
        response: errorText
      });
      
      let errorMessage = `Failed to exchange code for token: ${errorText}`;
      let userFriendlyMessage = 'There was an error connecting to Instagram.';
      
      // Check for common error patterns
      if (errorText.includes('Invalid platform app') || errorText.includes('invalid app')) {
        errorMessage = 'Instagram connection failed: Invalid platform app. The Instagram App ID is not correctly configured.';
        userFriendlyMessage = 'The Instagram application is not properly configured in the Meta Developer Portal.';
      } else if (errorText.includes('redirect_uri')) {
        errorMessage = 'Instagram connection failed: Redirect URI mismatch. The callback URL is not authorized in the Meta Developer Portal.';
        userFriendlyMessage = 'The callback URL is not registered in the Instagram application settings.';
      }
      
      // Create user-friendly error page
      const errorPage = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Instagram Connection Error</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; padding: 20px; max-width: 600px; margin: 0 auto; color: #333; }
            h1 { color: #d62976; }
            .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .message { background: #fff8e1; border-left: 4px solid #ffd54f; padding: 10px; margin: 20px 0; }
            .btn { display: inline-block; background: linear-gradient(45deg, #405de6, #5851db, #833ab4, #c13584, #e1306c, #fd1d1d); color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
            code { background: #f6f8fa; padding: 2px 5px; border-radius: 3px; font-family: monospace; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Instagram Connection Error</h1>
            <p>${userFriendlyMessage}</p>
            
            <div class="message">
              <p><strong>Error Details:</strong> ${errorMessage}</p>
            </div>
            
            <h3>Recommended Actions:</h3>
            <ul>
              <li>Verify that the Instagram Client ID and Secret are correctly configured</li>
              <li>Make sure the redirect URI <code>${INSTAGRAM_DIRECT_REDIRECT_URI}</code> is registered in the Meta Developer Portal</li>
              <li>Try using the "Connect via Facebook" option instead, which uses a different authentication flow</li>
            </ul>
            
            <a href="/connect" class="btn">Return to Connection Page</a>
          </div>
        </body>
        </html>
      `;
      
      return res.status(400).send(errorPage);
    }
    
    console.log('Token exchange successful, status:', tokenResponse.status);
    console.log('=======================================');
    
    // With Facebook OAuth flow, the response format is different
    // We receive an access_token but no user_id initially
    const tokenData = await tokenResponse.json() as { access_token: string, token_type: string, expires_in: number };
    const shortLivedToken = tokenData.access_token;
    
    console.log('Received short-lived Facebook token with expiry:', tokenData.expires_in);
    
    // First, we need to get the connected Instagram business accounts
    // Per docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started#exchange-token
    const igAccountsResponse = await fetch(
      `https://graph.facebook.com/v18.0/me/accounts?fields=name,access_token,instagram_business_account{id,name,username,profile_picture_url}&access_token=${shortLivedToken}`
    );
    
    if (!igAccountsResponse.ok) {
      const errorText = await igAccountsResponse.text();
      throw new Error(`Failed to fetch Instagram business accounts: ${errorText}`);
    }
    
    // Define the response type for Facebook Graph API
    interface FacebookPagesResponse {
      data: Array<{
        id: string;
        name: string;
        access_token: string;
        instagram_business_account?: {
          id: string;
          name?: string;
          username?: string;
          profile_picture_url?: string;
        };
      }>;
      paging?: {
        cursors: {
          before: string;
          after: string;
        };
      };
    }
    
    const igAccountsData = await igAccountsResponse.json() as FacebookPagesResponse;
    console.log('Instagram Business Accounts data:', JSON.stringify(igAccountsData));
    
    // Check if we have any Instagram business accounts
    if (!igAccountsData.data || igAccountsData.data.length === 0) {
      throw new Error('No Facebook Pages with connected Instagram Business accounts found. Please connect an Instagram account to your Facebook Page first.');
    }
    
    // Filter only accounts that have instagram_business_account
    const pagesWithInstagram = igAccountsData.data.filter(
      (page) => page.instagram_business_account
    );
    
    if (pagesWithInstagram.length === 0) {
      throw new Error('None of your Facebook Pages have connected Instagram Business accounts. Please connect an Instagram account to your Facebook Page first.');
    }
    
    // For now, use the first Instagram business account (we can add selection later)
    const selectedPage = pagesWithInstagram[0];
    const instagramAccount = selectedPage.instagram_business_account;
    const pageAccessToken = selectedPage.access_token;
    
    // This is now our Instagram Business Account ID and token
    const instagramAccountId = instagramAccount.id;
    const accessToken = pageAccessToken; // Use page access token for API calls
    
    // Get more details about the Instagram business account
    const profileResponse = await fetch(
      `https://graph.facebook.com/v18.0/${instagramAccountId}?fields=username,name,profile_picture_url&access_token=${accessToken}`
    );
    
    if (!profileResponse.ok) {
      const errorText = await profileResponse.text();
      throw new Error(`Failed to fetch Instagram business account details: ${errorText}`);
    }
    
    const profileData = await profileResponse.json() as { 
      id: string, 
      username?: string,
      name?: string
    };
    
    console.log('Instagram business account details:', profileData);
    
    // Instagram business accounts connected to Facebook pages are already business accounts
    // No need to verify account_type as we already confirmed it's connected to a Facebook page
    
    // Store the Instagram business account details
    // Prepare account data with the profile information we retrieved
    const accountId = instagramAccountId;
    const username = profileData.username || 'instagram_account';
    const name = profileData.name || username;
    
    // Store Instagram account info in session
    req.session.instagramUserName = username;
    req.session.instagramUserId = accountId;
    req.session.isDirectInstagramConnection = true;
    
    try {
      // Check if Instagram account already exists in our database
      const existingPage = await storage.getPageByPageId(accountId);
        
      if (!existingPage) {
        // Prepare metadata with Facebook Page info for reference
        const metadata = {
          fbPageId: selectedPage.id,
          fbPageName: selectedPage.name
        };
        
        // Add the Instagram account to our database
        await storage.createPage({
          name: name,
          pageId: accountId,
          platform: 'Instagram',
          accessToken: accessToken, // Using page access token from Facebook
          status: 'active',
          metadata: metadata
        });
        
        console.log(`Added new Instagram business account: ${name} (${accountId})`);
      } else {
        // Update existing page
        await storage.updatePage(existingPage.pageId, {
          accessToken: accessToken,
          name: name,
          status: 'active'
        });
        
        console.log(`Updated existing Instagram business account: ${name} (${accountId})`);
      }
      
      // Add user-page relationship if the user is logged in
      if (req.user && req.user.id) {
        await storage.assignPageToUser(req.user.id, instagramAccount.id);
        console.log(`Assigned Instagram account ${instagramAccount.id} to user ${req.user.id}`);
      }
      
      // Show success page
      const successPage = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Instagram Connected</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; padding: 20px; max-width: 600px; margin: 0 auto; color: #333; }
            h1 { color: #d62976; }
            .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .success-icon { font-size: 48px; color: #4CAF50; text-align: center; margin: 20px 0; }
            .btn { display: inline-block; background: linear-gradient(45deg, #405de6, #5851db, #833ab4, #c13584, #e1306c, #fd1d1d); color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success-icon">✓</div>
            <h1>Instagram Account Connected</h1>
            <p>Your Instagram account <strong>${instagramAccount.name}</strong> has been successfully connected to our platform.</p>
            <p>You can now start using the Instagram chatbot features.</p>
            <a href="/" class="btn">Go to Dashboard</a>
          </div>
        </body>
        </html>
      `;
      
      return res.send(successPage);
    } catch (error: any) {
      console.error('Error adding Instagram account:', error);
      res.status(500).send(`Error adding Instagram account: ${error.message}`);
    }
  } catch (error: any) {
    console.error('Direct Instagram OAuth callback error:', error);
    res.status(500).send(`Instagram OAuth Error: ${error.message}`);
  }
});

// This endpoint allows a user to select one of their Instagram accounts
// (For future use if needed, but currently using direct connection so not necessary)
router.post('/select-account', async (req: Request, res: Response) => {
  try {
    const { accountId, accountName, accessToken } = req.body;
    
    if (!accountId || !accountName || !accessToken) {
      return res.status(400).json({ success: false, message: 'Missing required account information' });
    }
    
    // Check if account already exists
    const existingPage = await storage.getPageByPageId(accountId);
    
    if (!existingPage) {
      // Add the Instagram account to our database
      await storage.createPage({
        name: accountName,
        pageId: accountId,
        platform: 'Instagram',
        accessToken: accessToken,
        status: 'active'
      });
    } else {
      // Update existing page
      await storage.updatePage(existingPage.pageId, {
        accessToken: accessToken,
        status: 'active'
      });
    }
    
    // Add user-page relationship if user is logged in
    if (req.user && req.user.id) {
      await storage.assignPageToUser(req.user.id, accountId);
    }
    
    // Set up the webhook subscription for this Instagram account
    try {
      const subscriptionResult = await subscribeToInstagramWebhooks(accessToken, accountId);
      if (subscriptionResult) {
        console.log(`Successfully set up webhook subscription for Instagram account ${accountId}`);
      } else {
        console.warn(`Failed to set up webhook subscription for Instagram account ${accountId}`);
        // Continue anyway as this is not critical for basic functionality
      }
    } catch (subscriptionError) {
      console.error('Error setting up Instagram webhook subscription:', subscriptionError);
      // Continue anyway as this is not critical for basic functionality
    }
    
    res.redirect('/?instagramSuccess=true');
  } catch (error: any) {
    console.error('Error selecting Instagram account:', error);
    res.status(500).send(`Error connecting Instagram account: ${error.message}`);
  }
});

/**
 * Subscribe to Instagram webhooks for a specific Instagram user
 * This is required to receive message notifications from Instagram
 * @param accessToken Long-lived access token for the Instagram account
 * @param instagramAccountId Instagram account ID to subscribe to
 */
async function subscribeToInstagramWebhooks(accessToken: string, instagramAccountId: string): Promise<boolean> {
  try {
    console.log(`Setting up Instagram webhook subscription for account ${instagramAccountId}`);
    
    // We need to use the client/app ID to create the subscription
    const appId = process.env.INSTAGRAM_CLIENT_ID || process.env.APP_ID;
    const appSecret = process.env.INSTAGRAM_CLIENT_SECRET;
    
    if (!appId || !appSecret) {
      console.error('Cannot subscribe to webhooks: Missing app credentials');
      return false;
    }

    // Webhook callback URL must match what's configured in Meta Developer Portal
    const webhookCallbackUrl = `${APP_DOMAIN}/webhook`;
    
    // Create the webhook subscription for the Instagram messages field
    // This follows the structure from the Instagram Webhooks documentation
    const subscriptionUrl = `https://graph.facebook.com/v18.0/${appId}/subscriptions`;
    
    const subscriptionParams = new URLSearchParams();
    subscriptionParams.append('access_token', `${appId}|${appSecret}`);
    subscriptionParams.append('object', 'instagram');
    subscriptionParams.append('callback_url', webhookCallbackUrl);
    subscriptionParams.append('fields', 'messages');
    subscriptionParams.append('verify_token', process.env.FACEBOOK_VERIFY_TOKEN || 'test_chat');
    
    console.log(`Subscription request URL: ${subscriptionUrl}`);
    console.log(`Webhook callback URL: ${webhookCallbackUrl}`);
    
    const response = await fetch(subscriptionUrl, {
      method: 'POST',
      body: subscriptionParams
    });
    
    const responseData = await response.json();
    
    if (response.ok) {
      console.log('Successfully subscribed to Instagram webhooks:', responseData);
      
      // Now we need to connect this specific Instagram account to the webhook 
      // Use fields=messages for direct message notifications
      const accountSubscriptionUrl = `https://graph.facebook.com/v18.0/${instagramAccountId}/subscribed_apps`;
      const accountParams = new URLSearchParams();
      accountParams.append('access_token', accessToken);
      accountParams.append('subscribed_fields', 'messages');
      
      const accountResponse = await fetch(accountSubscriptionUrl, {
        method: 'POST',
        body: accountParams
      });
      
      const accountData = await accountResponse.json();
      
      if (accountResponse.ok) {
        console.log(`Successfully subscribed app to Instagram account ${instagramAccountId}:`, accountData);
        return true;
      } else {
        console.error(`Failed to subscribe app to Instagram account ${instagramAccountId}:`, accountData);
        return false;
      }
    } else {
      console.error('Failed to create Instagram webhook subscription:', responseData);
      return false;
    }
  } catch (error) {
    console.error('Error setting up Instagram webhook subscription:', error);
    return false;
  }
}

export default router;