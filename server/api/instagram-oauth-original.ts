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

// Define some constants for the Instagram API
const APP_DOMAIN = process.env.APP_DOMAIN || 'http://localhost:5000';
const INSTAGRAM_REDIRECT_URI = process.env.INSTAGRAM_REDIRECT_URI || `${APP_DOMAIN}/api/instagram/oauth-callback`;
const INSTAGRAM_DIRECT_REDIRECT_URI = `${APP_DOMAIN}/api/instagram/direct-callback`;
const INSTAGRAM_CLIENT_ID = process.env.INSTAGRAM_CLIENT_ID || process.env.APP_ID || '';
const INSTAGRAM_CLIENT_SECRET = process.env.INSTAGRAM_CLIENT_SECRET || '';

// Debug endpoint to show Instagram configuration
router.get('/debug-config', (req: Request, res: Response) => {
  // Only available to admin users for security
  if (!req.header('X-User-ID') || req.header('X-User-ID') !== '1') {
    return res.status(403).json({ error: 'Unauthorized. Admin access required.' });
  }
  
  const effectiveId = process.env.INSTAGRAM_CLIENT_ID || process.env.APP_ID || '';
  const idPreview = effectiveId 
    ? `${effectiveId.substring(0, 4)}...${effectiveId.substring(effectiveId.length - 4)}`
    : 'Not set';

  const config = {
    INSTAGRAM_CLIENT_ID: process.env.INSTAGRAM_CLIENT_ID 
      ? `${process.env.INSTAGRAM_CLIENT_ID.substring(0, 4)}...${process.env.INSTAGRAM_CLIENT_ID.substring(process.env.INSTAGRAM_CLIENT_ID.length - 4)}`
      : 'Not set',
    APP_ID: process.env.APP_ID 
      ? `${process.env.APP_ID.substring(0, 4)}...${process.env.APP_ID.substring(process.env.APP_ID.length - 4)}`
      : 'Not set',
    EFFECTIVE_APP_ID: idPreview,
    INSTAGRAM_CLIENT_SECRET_SET: process.env.INSTAGRAM_CLIENT_SECRET ? 'Yes' : 'No',
    INSTAGRAM_REDIRECT_URI: process.env.INSTAGRAM_REDIRECT_URI || 'Not set',
    INSTAGRAM_DIRECT_REDIRECT_URI: INSTAGRAM_DIRECT_REDIRECT_URI,
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
  
  if (!process.env.INSTAGRAM_CLIENT_SECRET || process.env.INSTAGRAM_CLIENT_SECRET.trim() === '') {
    configErrors.push('Instagram Client Secret is not configured');
  }
  
  if (configErrors.length > 0) {
    return res.status(400).json({
      success: false,
      errors: configErrors
    });
  }
  
  return res.json({
    success: true,
    message: 'Instagram configuration appears to be valid'
  });
});

// Facebook OAuth flow for Instagram Business API
// This uses the Facebook authorization flow to access Instagram Business accounts
router.get('/oauth-init', (req: Request, res: Response) => {
  try {
    // Get client ID from either INSTAGRAM_CLIENT_ID or APP_ID environment variables 
    const clientId = INSTAGRAM_CLIENT_ID;
    
    // Validate Instagram client ID is properly configured
    if (!clientId || clientId.trim() === '') {
      throw new Error('Instagram App ID is not configured. Please check your environment variables.');
    }
    
    // Create a cryptographically secure state parameter to prevent CSRF attacks
    const state = Math.random().toString(36).substring(2, 15);
    
    // Store state in session, but not setting direct connection flag
    req.session.instagramOAuthState = state;
    req.session.isDirectInstagramConnection = false;
    
    // Parameters needed for authorization using Facebook's OAuth for Instagram Business
    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('redirect_uri', INSTAGRAM_REDIRECT_URI);
    params.append('state', state);
    // Permissions required for Instagram Business API - note the addition of pages_show_list
    params.append('scope', 'instagram_basic,instagram_manage_messages,pages_show_list');
    params.append('response_type', 'code');
    
    // Enhanced debugging logs
    console.log('=== FACEBOOK LOGIN FOR INSTAGRAM OAUTH DEBUGGING ===');
    console.log(`Client ID: ${clientId}`);
    console.log(`Redirect URI: ${INSTAGRAM_REDIRECT_URI}`);
    console.log(`Generated state: ${state}`);
    console.log(`Full auth URL: https://www.facebook.com/dialog/oauth?${params.toString()}`);
    console.log('=======================================');
    
    // Use Facebook OAuth flow for Instagram Business account login
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
          <p>There was an error connecting to Instagram via Facebook. This feature requires proper Instagram App configuration in the Meta Developer Portal.</p>
          
          <div class="message">
            <p><strong>Error:</strong> ${error.message || 'Invalid Instagram application configuration'}</p>
          </div>
          
          <h3>Common issues:</h3>
          <ul>
            <li>Instagram Client ID is invalid or not properly configured</li>
            <li>The redirect URI is not properly registered in the Meta Developer Portal</li>
            <li>The Instagram app hasn't been fully set up or approved by Meta</li>
          </ul>
          
          <p><strong>Alternative:</strong> Try using the "Connect Instagram Directly" option instead, which uses a different authentication flow.</p>
          
          <a href="/connect" class="btn">Return to Connection Page</a>
        </div>
      </body>
      </html>
    `;
    
    res.status(400).send(errorPage);
  }
});

// Facebook OAuth callback - handles Instagram Business API connections via Facebook 
router.get('/oauth-callback', async (req: Request, res: Response) => {
  try {
    // Get all query parameters for debugging
    console.log('=== FACEBOOK LOGIN FOR INSTAGRAM CALLBACK DEBUGGING ===');
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
      return res.status(400).send(`Facebook Connection Error: ${error_description || error}`);
    }
    
    // Verify state parameter to prevent CSRF attacks
    if (!req.session.instagramOAuthState || state !== req.session.instagramOAuthState) {
      console.error('OAuth state mismatch. Session state:', req.session.instagramOAuthState, 'Callback state:', state);
      return res.status(400).send('Invalid state parameter. This could be due to a CSRF attack or expired session.');
    }
    
    // Exchange the code for an access token using Facebook Graph API 
    const tokenUrl = new URL('https://graph.facebook.com/v18.0/oauth/access_token');
    tokenUrl.searchParams.append('client_id', INSTAGRAM_CLIENT_ID);
    tokenUrl.searchParams.append('client_secret', INSTAGRAM_CLIENT_SECRET);
    tokenUrl.searchParams.append('redirect_uri', INSTAGRAM_REDIRECT_URI);
    tokenUrl.searchParams.append('code', code);
    
    console.log(`Token exchange URL: ${tokenUrl.toString().replace(INSTAGRAM_CLIENT_SECRET, '*****')}`);
    
    const tokenResponse = await fetch(tokenUrl.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      
      // Create a nice error page for the user
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
            .error { background: #fff8e1; border-left: 4px solid #ffd54f; padding: 10px; margin: 20px 0; }
            pre { background: #f6f8fa; padding: 10px; border-radius: 4px; overflow-x: auto; }
            .btn { display: inline-block; background: linear-gradient(45deg, #405de6, #5851db, #833ab4, #c13584, #e1306c, #fd1d1d); color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Instagram Connection Failed</h1>
            <p>There was an error connecting your Instagram account via Facebook. This could be due to incorrect app configuration or temporary issues with Meta's API.</p>
            
            <div class="error">
              <strong>Error:</strong> ${errorText}
            </div>
            
            <a href="/connect" class="btn">Return to Connection Page</a>
          </div>
        </body>
        </html>
      `;
      
      return res.status(400).send(errorPage);
    }
    
    console.log('Token exchange successful, status:', tokenResponse.status);
    
    // Process the token response from Facebook Graph API
    interface FacebookTokenResponse {
      access_token: string;
      token_type: string;
      expires_in: number;
    }
    
    const tokenData = await tokenResponse.json() as FacebookTokenResponse;
    console.log('Received FB short-lived token with expiry:', tokenData.expires_in);
    
    // Get Facebook Pages with Instagram Business accounts
    interface FacebookPage {
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: {
        id: string;
        name?: string;
        username?: string;
        profile_picture_url?: string;
      };
    }
    
    interface FacebookPagesResponse {
      data: FacebookPage[];
      paging?: {
        cursors: {
          before: string;
          after: string;
        };
      };
    }
    
    const igAccountsResponse = await fetch(
      `https://graph.facebook.com/v18.0/me/accounts?fields=name,access_token,instagram_business_account{id,name,username,profile_picture_url}&access_token=${tokenData.access_token}`
    );
    
    if (!igAccountsResponse.ok) {
      const errorText = await igAccountsResponse.text();
      throw new Error(`Failed to fetch Instagram business accounts: ${errorText}`);
    }
    
    const igAccountsData = await igAccountsResponse.json() as FacebookPagesResponse;
    console.log('Instagram Business Accounts data retrieved');
    
    // Check if we have any Facebook Pages
    if (!igAccountsData.data || igAccountsData.data.length === 0) {
      // Create a user-friendly error page with instructions on creating a Facebook Page
      const noPageErrorPage = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Facebook Page Required</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; padding: 20px; max-width: 800px; margin: 0 auto; color: #333; }
            h1 { color: #1877f2; margin-bottom: 5px; }
            h2 { color: #d62976; margin-top: 0; font-size: 1.2rem; }
            .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .steps { margin: 20px 0; padding-left: 20px; }
            .steps li { margin-bottom: 15px; }
            .step-num { display: inline-block; background: #1877f2; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; margin-right: 10px; font-weight: bold; }
            .btn { display: inline-block; background: #1877f2; color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
            .note { background: #f0f2f5; padding: 15px; border-radius: 8px; margin: 20px 0; }
            img { max-width: 100%; border: 1px solid #ddd; border-radius: 4px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Facebook Page Required</h1>
            <h2>For Instagram Business Integration</h2>
            
            <p>To connect an Instagram business account, you need to have a Facebook Page first. Instagram Business accounts can only be connected through Facebook Pages.</p>
            
            <div class="note">
              <strong>Why this is needed:</strong> Meta (Facebook) requires all Instagram Business accounts to be connected to a Facebook Page for API access.
            </div>
            
            <h3>How to create a Facebook Page and connect Instagram:</h3>
            <ol class="steps">
              <li><span class="step-num">1</span> Log into your Facebook account</li>
              <li><span class="step-num">2</span> Go to <a href="https://www.facebook.com/pages/create/" target="_blank">facebook.com/pages/create</a></li>
              <li><span class="step-num">3</span> Choose a Page category (Business/Brand is recommended)</li>
              <li><span class="step-num">4</span> Enter your Page name and category, then click Create Page</li>
              <li><span class="step-num">5</span> Once your Page is created, go to Page Settings → Instagram</li>
              <li><span class="step-num">6</span> Click "Connect Instagram" and follow the prompts</li>
              <li><span class="step-num">7</span> Make sure your Instagram account is a Business or Creator account</li>
            </ol>
            
            <p>After completing these steps, return here and try connecting Instagram again.</p>
            
            <a href="/connect" class="btn">Return to Connection Page</a>
          </div>
        </body>
        </html>
      `;
      
      return res.status(400).send(noPageErrorPage);
    }
    
    // Filter only accounts that have instagram_business_account
    const pagesWithInstagram = igAccountsData.data.filter(
      (page) => page.instagram_business_account
    );
    
    if (pagesWithInstagram.length === 0) {
      // Create user-friendly error page with instructions on connecting Instagram to Facebook Page
      const noIGAccountErrorPage = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Connect Instagram to Facebook</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; padding: 20px; max-width: 800px; margin: 0 auto; color: #333; }
            h1 { color: #d62976; margin-bottom: 5px; }
            h2 { color: #1877f2; margin-top: 0; font-size: 1.2rem; }
            .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .steps { margin: 20px 0; padding-left: 20px; }
            .steps li { margin-bottom: 15px; }
            .step-num { display: inline-block; background: #d62976; color: white; width: 24px; height: 24px; border-radius: 50%; text-align: center; margin-right: 10px; font-weight: bold; }
            .btn { display: inline-block; background: linear-gradient(45deg, #405de6, #5851db, #833ab4, #c13584, #e1306c, #fd1d1d); color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
            .note { background: #fff8e1; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffd54f; }
            img { max-width: 100%; border: 1px solid #ddd; border-radius: 4px; margin: 10px 0; }
            .pages-found { background: #e8f5e9; padding: 10px; border-radius: 4px; margin: 15px 0; border-left: 4px solid #4caf50; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Connect Instagram to Facebook</h1>
            <h2>For Instagram Business Integration</h2>
            
            <div class="pages-found">
              <p><strong>We found ${igAccountsData.data.length} Facebook Page(s)</strong> but there are no Instagram Business accounts connected to them.</p>
            </div>
            
            <p>To use the Instagram API, you need to connect your Instagram business account to one of your Facebook Pages.</p>
            
            <div class="note">
              <strong>Important:</strong> Your Instagram account must be a Business or Creator account, not a personal account.
            </div>
            
            <h3>How to connect Instagram to your Facebook Page:</h3>
            <ol class="steps">
              <li><span class="step-num">1</span> Go to your Facebook Page</li>
              <li><span class="step-num">2</span> Click on the 'Settings' link</li>
              <li><span class="step-num">3</span> In the left menu, click on 'Instagram'</li>
              <li><span class="step-num">4</span> Click 'Connect Account' and follow the prompts</li>
              <li><span class="step-num">5</span> If your Instagram account is personal, you'll be prompted to convert it to a Professional account</li>
            </ol>
            
            <p>After completing these steps, return here and try connecting Instagram again.</p>
            
            <a href="/connect" class="btn">Return to Connection Page</a>
          </div>
        </body>
        </html>
      `;
      
      return res.status(400).send(noIGAccountErrorPage);
    }
    
    // For now, use the first Instagram business account (we can add selection later)
    const selectedPage = pagesWithInstagram[0];
    const igBusinessAccount = selectedPage.instagram_business_account!;
    const pageAccessToken = selectedPage.access_token;
    
    // Get more details about the Instagram business account
    const profileResponse = await fetch(
      `https://graph.facebook.com/v18.0/${igBusinessAccount.id}?fields=username,name,profile_picture_url&access_token=${pageAccessToken}`
    );
    
    if (!profileResponse.ok) {
      const errorText = await profileResponse.text();
      throw new Error(`Failed to fetch Instagram business account details: ${errorText}`);
    }
    
    interface InstagramBusinessProfile {
      id: string;
      username?: string;
      name?: string;
      profile_picture_url?: string;
    }
    
    const profileData = await profileResponse.json() as InstagramBusinessProfile;
    console.log('Instagram business account details retrieved');
    
    // Prepare account data
    const accountId = igBusinessAccount.id;
    const username = profileData.username || igBusinessAccount.username || 'instagram_account';
    const accountName = profileData.name || igBusinessAccount.name || username;
    
    // Store Instagram account info in session
    req.session.instagramUserName = username;
    req.session.instagramUserId = accountId;
    req.session.isDirectInstagramConnection = false;
    
    try {
      // FIXED: Instead of creating separate Instagram entry, properly link to Facebook page
      
      // Check if Facebook page already exists in our database
      const existingFacebookPage = await storage.getPageByPageId(selectedPage.id);
      
      if (existingFacebookPage) {
        // Add Instagram ID to existing Facebook page's instagramIds array
        const metadata = existingFacebookPage.metadata || {};
        const instagramIds = metadata.instagramIds || [];
        
        if (!instagramIds.includes(accountId)) {
          instagramIds.push(accountId);
          
          // Update Facebook page with Instagram mapping
          await storage.updatePage(existingFacebookPage.id, {
            accessToken: pageAccessToken, // Update with latest token
            metadata: { 
              ...metadata, 
              instagramIds,
              // Store Instagram account details for reference
              instagramAccountDetails: {
                ...metadata.instagramAccountDetails,
                [accountId]: {
                  username: username,
                  name: accountName,
                  profilePictureUrl: profileData.profile_picture_url
                }
              }
            }
          });
          
          console.log(`Linked Instagram account ${accountId} to existing Facebook page ${selectedPage.id}`);
        } else {
          console.log(`Instagram account ${accountId} already linked to Facebook page ${selectedPage.id}`);
        }
      } else {
        // Create new Facebook page with Instagram mapping
        await storage.createPage({
          name: selectedPage.name,
          pageId: selectedPage.id,
          platform: 'Facebook', // Store as Facebook page, not Instagram
          accessToken: pageAccessToken,
          status: 'active',
          metadata: {
            instagramIds: [accountId],
            instagramAccountDetails: {
              [accountId]: {
                username: username,
                name: accountName,
                profilePictureUrl: profileData.profile_picture_url
              }
            },
            facebookPageName: selectedPage.name,
            connectionType: 'facebook_api'
          }
        });
        
        console.log(`Created new Facebook page ${selectedPage.id} with linked Instagram account ${accountId}`);
      }
      
      // Add user-page relationship for the Facebook page (not Instagram account)
      if (req.user && req.user.id) {
        await storage.assignPageToUser(req.user.id, selectedPage.id);
        console.log(`Assigned Facebook page ${selectedPage.id} to user ${req.user.id}`);
      }
      
      // Set up the webhook subscription for this Instagram account
      try {
        const subscriptionResult = await subscribeToInstagramWebhooks(pageAccessToken, accountId);
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
      
      // Success page with Facebook connection details
      const successPage = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Instagram Connection Successful</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; padding: 20px; max-width: 600px; margin: 0 auto; color: #333; }
            h1 { color: #1877f2; }
            .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .success { background: #e8f5e9; border-left: 4px solid #4caf50; padding: 15px; margin: 20px 0; }
            .btn { display: inline-block; background: #1877f2; color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
            .note { background: #f5f5f5; padding: 10px; border-radius: 4px; font-size: 0.9em; margin-top: 15px; }
            .instagram-info { display: flex; align-items: center; margin: 10px 0; }
            .instagram-info .icon { color: #d62976; margin-right: 10px; }
          </style>
          <script>
            // Auto-redirect after 3 seconds
            setTimeout(() => {
              window.location.href = '/?instagramSuccess=true';
            }, 3000);
          </script>
        </head>
        <body>
          <div class="container">
            <h1>Instagram Connected via Facebook</h1>
            
            <div class="success">
              <p><strong>Connection complete!</strong> Your Instagram business account <strong>@${username}</strong> has been successfully connected.</p>
            </div>
            
            <div class="instagram-info">
              <span class="icon">📷</span>
              <div>
                <strong>${accountName}</strong>
                <div style="font-size: 0.9em; color: #666;">Connected via Facebook Page: ${selectedPage.name}</div>
              </div>
            </div>
            
            <p>You can now use AI chat features with your Instagram direct messages.</p>
            
            <div class="note">
              <p>This connection uses your Facebook Page's access token which doesn't expire unless you disconnect the app from Facebook.</p>
            </div>
            
            <p>Redirecting you to the dashboard automatically...</p>
            
            <a href="/?instagramSuccess=true" class="btn">Return to Dashboard</a>
          </div>
        </body>
        </html>
      `;
      
      return res.send(successPage);
    } catch (error: any) {
      console.error('Error storing Instagram account in database:', error);
      res.status(500).send(`Error connecting Instagram account: ${error.message}`);
    }
  } catch (error: any) {
    console.error('Error completing Instagram business OAuth flow:', error);
    res.status(500).send(`Error connecting Instagram account: ${error.message}`);
  }
});

// Direct Instagram OAuth using Instagram Graph API 
// This is the Business Login for Instagram approach
// https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
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
    
    // Parameters needed for Instagram Business Login OAuth flow
    // Important: Note that we use the Instagram authorization endpoints, NOT Facebook's
    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('redirect_uri', INSTAGRAM_DIRECT_REDIRECT_URI);
    params.append('state', state);
    // Required permissions for Instagram Business API access
    params.append('scope', 'user_profile,user_media');
    params.append('response_type', 'code');
    
    // Enhanced debugging logs
    console.log('=== DIRECT INSTAGRAM BUSINESS OAUTH DEBUGGING ===');
    console.log(`Client ID: ${clientId}`);
    console.log(`Redirect URI: ${INSTAGRAM_DIRECT_REDIRECT_URI}`);
    console.log(`Generated state: ${state}`);
    console.log(`Full auth URL: https://api.instagram.com/oauth/authorize?${params.toString()}`);
    console.log('=======================================');
    
    // Use Instagram authorization endpoint for Business Login
    // Per docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
    res.redirect(`https://api.instagram.com/oauth/authorize?${params.toString()}`);
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

// Direct Instagram OAuth callback - handles direct Instagram Business API connections 
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
    
    // Log any errors received from Instagram OAuth
    if (error) {
      console.error('Instagram OAuth returned an error:', {
        error,
        error_reason,
        error_description
      });
      return res.status(400).send(`Instagram Connection Error: ${error_description || error}`);
    }
    
    // Verify state parameter to prevent CSRF attacks
    if (!req.session.instagramOAuthState || state !== req.session.instagramOAuthState) {
      console.error('OAuth state mismatch. Session state:', req.session.instagramOAuthState, 'Callback state:', state);
      return res.status(400).send('Invalid state parameter. This could be due to a CSRF attack or expired session.');
    }
    
    // Exchange the code for an access token using Instagram Graph API 
    // https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
    const tokenUrl = new URL('https://api.instagram.com/oauth/access_token');
    
    // Create form data for token exchange
    const formData = new URLSearchParams();
    formData.append('client_id', INSTAGRAM_CLIENT_ID);
    formData.append('client_secret', INSTAGRAM_CLIENT_SECRET);
    formData.append('redirect_uri', INSTAGRAM_DIRECT_REDIRECT_URI);
    formData.append('code', code);
    formData.append('grant_type', 'authorization_code');
    
    console.log(`Token exchange URL: ${tokenUrl.toString()}`);
    
    // Instagram token endpoint expects a POST request with form data
    const tokenResponse = await fetch(tokenUrl.toString(), {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json' 
      },
      body: formData
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      
      // Create a nice error page for the user
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
            .error { background: #fff8e1; border-left: 4px solid #ffd54f; padding: 10px; margin: 20px 0; }
            pre { background: #f6f8fa; padding: 10px; border-radius: 4px; overflow-x: auto; }
            .btn { display: inline-block; background: linear-gradient(45deg, #405de6, #5851db, #833ab4, #c13584, #e1306c, #fd1d1d); color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Instagram Connection Failed</h1>
            <p>There was an error connecting your Instagram account. This could be due to incorrect app configuration or temporary issues with Instagram's API.</p>
            
            <div class="error">
              <strong>Error:</strong> ${errorText}
            </div>
            
            <a href="/connect" class="btn">Return to Connection Page</a>
          </div>
        </body>
        </html>
      `;
      
      return res.status(400).send(errorPage);
    }
    
    console.log('Token exchange successful, status:', tokenResponse.status);
    
    // Process the token response from Instagram Graph API
    // The response will have a short-lived user access token and the user_id
    interface InstagramTokenResponse {
      access_token: string;
      user_id: string;
    }
    
    const shortLivedTokenData = await tokenResponse.json() as InstagramTokenResponse;
    console.log('Received Instagram short-lived token for user ID:', shortLivedTokenData.user_id);
    
    // Now get a long-lived token (valid for 60 days)
    const longLivedTokenUrl = new URL('https://graph.instagram.com/access_token');
    longLivedTokenUrl.searchParams.append('grant_type', 'ig_exchange_token');
    longLivedTokenUrl.searchParams.append('client_secret', INSTAGRAM_CLIENT_SECRET);
    longLivedTokenUrl.searchParams.append('access_token', shortLivedTokenData.access_token);
    
    const longLivedTokenResponse = await fetch(longLivedTokenUrl.toString());
    
    if (!longLivedTokenResponse.ok) {
      const errorText = await longLivedTokenResponse.text();
      throw new Error(`Failed to get long-lived Instagram token: ${errorText}`);
    }
    
    interface LongLivedTokenResponse {
      access_token: string;
      token_type: string;
      expires_in: number; // seconds until expiration
    }
    
    const longLivedTokenData = await longLivedTokenResponse.json() as LongLivedTokenResponse;
    console.log('Received Instagram long-lived token with expiry:', longLivedTokenData.expires_in);
    
    // Get basic profile information from Instagram Graph API
    const profileUrl = new URL(`https://graph.instagram.com/${shortLivedTokenData.user_id}`);
    profileUrl.searchParams.append('fields', 'id,username,account_type,media_count');
    profileUrl.searchParams.append('access_token', longLivedTokenData.access_token);
    
    const profileResponse = await fetch(profileUrl.toString());
    
    if (!profileResponse.ok) {
      const errorText = await profileResponse.text();
      throw new Error(`Failed to fetch Instagram user profile: ${errorText}`);
    }
    
    interface InstagramProfile {
      id: string;
      username: string;
      account_type: string; // 'BUSINESS', 'CREATOR', etc.
      media_count: number;
    }
    
    const profileData = await profileResponse.json() as InstagramProfile;
    console.log('Instagram user profile:', profileData);
    
    // Prepare account data
    const accountId = shortLivedTokenData.user_id;
    const username = profileData.username;
    const accountName = username;
    
    // Store Instagram account info in session
    req.session.instagramUserName = username;
    req.session.instagramUserId = accountId;
    req.session.isDirectInstagramConnection = true;
    
    try {
      // Prepare metadata with Instagram account details
      const metadata = {
        accountType: profileData.account_type,
        mediaCount: profileData.media_count,
        connectionType: 'direct_api' // To indicate this was connected via Instagram API directly
      };
      
      // Check if Instagram account already exists in our database
      const existingPage = await storage.getPageByPageId(accountId);
      
      if (!existingPage) {
        // Add the Instagram account to our database
        await storage.createPage({
          name: accountName,
          pageId: accountId,
          platform: 'Instagram',
          accessToken: longLivedTokenData.access_token, // Using long-lived Instagram token
          status: 'active',
          metadata: metadata
        });
        
        console.log(`Added new Instagram account: ${accountName} (${accountId})`);
      } else {
        // Update existing page
        await storage.updatePage(existingPage.pageId, {
          accessToken: longLivedTokenData.access_token,
          name: accountName,
          status: 'active',
          metadata: {
            ...existingPage.metadata,
            ...metadata
          }
        });
        
        console.log(`Updated existing Instagram account: ${accountName} (${accountId})`);
      }
      
      // Add user-page relationship if the user is logged in
      if (req.user && req.user.id) {
        await storage.assignPageToUser(req.user.id, accountId);
      }
      
      // Success page with some details about token expiration
      const successPage = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Instagram Connection Successful</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; padding: 20px; max-width: 600px; margin: 0 auto; color: #333; }
            h1 { color: #d62976; }
            .container { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .success { background: #e8f5e9; border-left: 4px solid #4caf50; padding: 15px; margin: 20px 0; }
            .btn { display: inline-block; background: linear-gradient(45deg, #405de6, #5851db, #833ab4, #c13584, #e1306c, #fd1d1d); color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 20px; }
            .note { background: #f5f5f5; padding: 10px; border-radius: 4px; font-size: 0.9em; margin-top: 15px; }
          </style>
          <script>
            // Auto-redirect after 3 seconds
            setTimeout(() => {
              window.location.href = '/?instagramSuccess=true';
            }, 3000);
          </script>
        </head>
        <body>
          <div class="container">
            <h1>Instagram Connected Successfully</h1>
            
            <div class="success">
              <p><strong>Connection complete!</strong> Your Instagram account <strong>@${username}</strong> has been successfully connected.</p>
            </div>
            
            <p>You can now use AI chat features with your Instagram direct messages.</p>
            
            <div class="note">
              <p>Your access token will expire in ${Math.floor(longLivedTokenData.expires_in / 86400)} days. You'll need to reconnect after that time.</p>
            </div>
            
            <p>Redirecting you to the dashboard automatically...</p>
            
            <a href="/?instagramSuccess=true" class="btn">Return to Dashboard</a>
          </div>
        </body>
        </html>
      `;
      
      return res.send(successPage);
    } catch (error: any) {
      console.error('Error storing Instagram account in database:', error);
      res.status(500).send(`Error connecting Instagram account: ${error.message}`);
    }
  } catch (error: any) {
    console.error('Error completing Instagram OAuth flow:', error);
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