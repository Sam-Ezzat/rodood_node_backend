import { Router, Request, Response } from 'express';
import { storage } from '../storage';
import fetch from 'node-fetch';
import 'express-session';

// Extend the Express session interface to add our own properties
declare module 'express-session' {
  interface SessionData {
    oauthState?: string;
    facebookPages?: Array<{id: string, name: string, access_token: string}>;
    // Added for user tracking during OAuth flow
    connectingFbUserId?: string;
  }
}

// Create a router for Facebook OAuth
const router = Router();

// Facebook OAuth configuration
// App ID and App Secret are taken from environment variables
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || '';
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';

// Get the domain for OAuth redirects - works for both development and production
const APP_DOMAIN = (process.env.APP_DOMAIN || process.env.REPLIT_DOMAIN)?.replace(/\/$/, '');

// For logging purposes
console.log('Using domain for OAuth:', APP_DOMAIN);

// OAuth initialization endpoint - redirects user to Facebook authorization page
router.get('/oauth-init', (req: Request, res: Response) => {
  // Create a cryptographically secure state parameter to prevent CSRF attacks
  let state = Math.random().toString(36).substring(2, 15);
  
  // Enhanced user ID detection for OAuth flows
  let userId: string | number | null = null;
  
  // Option 1: Check URL parameter (most reliable)
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
  // Option 4: Check session user
  else if ((req.session as any).user && (req.session as any).user.id) {
    userId = ((req.session as any).user.id).toString();
    console.log(`Using authenticated user ID from session: ${userId}`);
  }
  
  // Store the user ID in both session AND state parameter for maximum reliability
  if (userId) {
    req.session.connectingFbUserId = userId.toString();
    // Encode user ID in state parameter as backup
    state = `${state}_uid${userId}`;
    console.log(`User ID ${userId} encoded in state parameter: ${state}`);
    
    // Save session immediately to ensure it's persisted
    req.session.save((err) => {
      if (err) {
        console.error('Error saving user ID to session:', err);
      } else {
        console.log(`Successfully saved user ID ${userId} in session for Facebook OAuth flow`);
      }
    });
  } else {
    console.warn('No user ID found when starting Facebook OAuth flow');
    console.log('Pages will not be assigned to any user to prevent wrong assignments');
  }
  
  // Parameters needed for authorization
  const params = new URLSearchParams();
  params.append('client_id', FACEBOOK_APP_ID);
  params.append('redirect_uri', `${APP_DOMAIN}/api/facebook/oauth-callback`);
  params.append('state', state);
  // Include the user ID in the state to make it more reliable
  if (userId) {
    params.append('user_id', userId.toString());
  }
  params.append('scope', 'pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement,pages_read_user_content,pages_manage_ads,public_profile');
  params.append('response_type', 'code');
  
  // Log the state for debugging
  console.log(`OAuth state created: ${state}`);
  
  // Redirect to Facebook for authorization
  res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`);
});

// OAuth callback endpoint - where Facebook redirects after user authorization
router.get('/oauth-callback', async (req: Request, res: Response) => {
  try {
    // Get the authorization code from query parameters
    const code = req.query.code as string;
    const userIdFromUrl = req.query.user_id as string;
    const state = req.query.state as string;
    
    // Debug: Log all query parameters to see what Facebook actually returns
    console.log('=== FACEBOOK OAUTH CALLBACK DEBUG ===');
    console.log('All query parameters:', req.query);
    console.log('Code:', code);
    console.log('User ID from URL:', userIdFromUrl);
    console.log('State:', state);
    console.log('Session state:', req.session.oauthState);
    console.log('Session user ID:', req.session.connectingFbUserId);
    
    // CRITICAL FIX: Extract user ID from state parameter (most reliable method)
    let userId: string | null = null;
    
    // Primary method: Extract user ID from state parameter
    if (state && state.includes('_uid')) {
      const match = state.match(/_uid(\d+)$/);
      if (match) {
        userId = match[1];
        console.log(`✅ Extracted user ID from state parameter: ${userId}`);
        
        // Validate this against session state (without requiring exact match due to session issues)
        const baseState = state.replace(/_uid\d+$/, '');
        if (req.session.oauthState === baseState || req.session.oauthState === state) {
          console.log('✅ State parameter validated successfully');
        } else {
          console.log('⚠️ Session state differs but user ID extracted from state parameter');
        }
      }
    }
    
    // Fallback: Try session if state extraction failed
    if (!userId && req.session.connectingFbUserId) {
      userId = req.session.connectingFbUserId;
      console.log(`⚠️ Using session user ID as fallback: ${userId}`);
    }
    
    // Final fallback: URL parameter (unlikely to work with Facebook)
    if (!userId && userIdFromUrl) {
      userId = userIdFromUrl;
      console.log(`⚠️ Using URL parameter as last resort: ${userId}`);
    }
    
    // DO NOT default to any user - prevent wrong assignments
    if (!userId) {
      console.error('❌ CRITICAL: No user ID found in OAuth callback');
      console.log('Session ID:', req.sessionID);
      console.log('Session data:', JSON.stringify(req.session, null, 2));
      console.log('This page will NOT be assigned to any user to prevent wrong assignments');
    }
    
    // Extra debug information
    console.log(`Callback session data:`, {
      userId: userId,
      sessionId: req.session.id,
      hasConnectingId: !!req.session.connectingFbUserId
    });
    
    // Log receipt of OAuth callback
    console.log('Received OAuth callback with code, proceeding to token exchange');
    
    // The redirect URI must match exactly with what was sent in the authorization request
    const redirectUri = `${APP_DOMAIN}/api/facebook/oauth-callback`;
    console.log('Using OAuth callback URL:', redirectUri);
    
    // Exchange the code for an access token
    const tokenResponse = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?client_id=${FACEBOOK_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${FACEBOOK_APP_SECRET}&code=${code}`);
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`Failed to exchange code for token: ${errorText}`);
    }
    
    const tokenData = await tokenResponse.json() as { access_token: string, expires_in: number };
    const shortLivedToken = tokenData.access_token;
    
    // Exchange short-lived token for a long-lived token
    const longLivedTokenResponse = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${FACEBOOK_APP_ID}&client_secret=${FACEBOOK_APP_SECRET}&fb_exchange_token=${shortLivedToken}`);
    
    if (!longLivedTokenResponse.ok) {
      const errorText = await longLivedTokenResponse.text();
      throw new Error(`Failed to exchange for long-lived token: ${errorText}`);
    }
    
    const longLivedTokenData = await longLivedTokenResponse.json() as { access_token: string, expires_in: number };
    const longLivedToken = longLivedTokenData.access_token;
    
    // Fetch user's pages with this token
    const pagesResponse = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${longLivedToken}`);
    
    if (!pagesResponse.ok) {
      const errorText = await pagesResponse.text();
      throw new Error(`Failed to fetch pages: ${errorText}`);
    }
    
    const pagesData = await pagesResponse.json() as { data: Array<{id: string, name: string, access_token: string}> };
    
    // Check if the user has any pages
    if (!pagesData.data || pagesData.data.length === 0) {
      return res.status(400).send('No Facebook Pages found. Please create a Facebook Page or check page permissions.');
    }
    
    // If only one page, add it automatically
    if (pagesData.data.length === 1) {
      const page = pagesData.data[0];
      
      try {
        // Check if page already exists
        const existingPage = await storage.getPageByPageId(page.id);
        
        if (!existingPage) {
          // Add the page to our database
          await storage.createPage({
            name: page.name,
            pageId: page.id,
            platform: 'Facebook',
            accessToken: page.access_token,
            status: 'active'
          });
          
          // CRITICAL FIX: Assign page to the connecting user using the extracted userId
          if (userId) {
            const userIdInt = parseInt(userId);
            if (!isNaN(userIdInt)) {
              await storage.assignPageToUser(userIdInt, page.id);
              console.log(`✅ ASSIGNED page ${page.id} to user ${userIdInt} (extracted from state parameter)`);
            } else {
              console.error(`❌ Invalid user ID format: ${userId}`);
            }
          } else {
            console.error(`❌ CRITICAL: Page ${page.id} created but NO USER ID available for assignment!`);
          }
          
          // Subscribe to webhooks
          try {
            console.log(`Attempting to subscribe page ${page.id} (${page.name}) to webhooks...`);
            const webhookResponse = await fetch(`https://graph.facebook.com/v18.0/${page.id}/subscribed_apps`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ access_token: page.access_token })
            });
            
            const webhookResult = await webhookResponse.json();
            
            if (!webhookResponse.ok) {
              console.error(`Failed to subscribe to webhooks: ${JSON.stringify(webhookResult)}`);
            } else {
              console.log(`Successfully subscribed to webhooks for page ${page.id}: ${JSON.stringify(webhookResult)}`);
            }
          } catch (webhookError) {
            console.error(`Error during webhook subscription for page ${page.id}: ${webhookError}`);
            // Continue with the flow even if webhook subscription fails
          }
        } else {
          // Update existing page
          await storage.updatePage(existingPage.id, {
            accessToken: page.access_token,
            status: 'active'
          });
        }
      } catch (error) {
        console.error('Error adding page to database:', error);
      }
      
      // Redirect to the connect page with success message
      return res.redirect('/?success=true&pageCount=1');
    } else {
      // For multiple pages, encode them in the URL query param
      try {
        // Create a compressed version of the pages data
        const pagesJson = JSON.stringify(pagesData.data);
        const encodedPages = encodeURIComponent(pagesJson);
        
        console.log(`Redirecting with ${pagesData.data.length} pages in URL`);
        
        // Redirect to the page selector with the encoded pages data
        return res.redirect(`/?selectPage=true&pagesData=${encodedPages}`);
      } catch (error) {
        console.error('Error encoding pages data:', error);
        return res.status(500).send('Error processing page data');
      }
    }
  } catch (error: any) {
    console.error('OAuth callback error:', error);
    res.status(500).send(`OAuth Error: ${error.message}`);
  }
});

// Endpoint for selecting which pages to connect when user has multiple pages
// NOTE: This endpoint now requires authentication since it was removed from publicEndpoints
router.post('/connect-pages', async (req: Request, res: Response) => {
  try {
    // Comprehensive debug logging for user ID detection
    console.log('=== FACEBOOK CONNECT-PAGES DEBUG ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('Request headers x-user-id:', req.headers['x-user-id']);
    console.log('Request user object:', req.user);
    console.log('Session data:', JSON.stringify(req.session, null, 2));
    
    // Get selected page IDs from request body
    const selectedPageIds = req.body.pageIds as string[];
    const pagesDataFromBody = req.body.pagesData;
    
    if (!Array.isArray(selectedPageIds) || selectedPageIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No pages selected' });
    }
    
    // Get pages data from request body or session (fallback)
    let pages = [];
    if (pagesDataFromBody && Array.isArray(pagesDataFromBody)) {
      pages = pagesDataFromBody;
      console.log('Using pages data from request body');
    } else if (req.session.facebookPages) {
      pages = req.session.facebookPages;
      console.log('Using pages data from session');
    } else {
      return res.status(400).json({ success: false, message: 'No pages data found' });
    }
    
    const selectedPages = pages.filter(page => selectedPageIds.includes(page.id));
    
    // Add each selected page
    for (const page of selectedPages) {
      try {
        // Check if page already exists
        const existingPage = await storage.getPageByPageId(page.id);
        
        if (!existingPage) {
          // Add the page to our database
          await storage.createPage({
            name: page.name,
            pageId: page.id,
            platform: 'Facebook',
            accessToken: page.access_token,
            status: 'active'
          });
          
          // Subscribe to webhooks
          const webhookResponse = await fetch('https://graph.facebook.com/v18.0/' + page.id + '/subscribed_apps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: page.access_token })
          });
          
          if (!webhookResponse.ok) {
            console.error('Failed to subscribe to webhooks for page:', page.id);
          }
        } else {
          // Update existing page
          await storage.updatePage(existingPage.id, {
            accessToken: page.access_token,
            status: 'active'
          });
        }
      } catch (error) {
        console.error('Error adding page to database:', error);
      }
    }
    
    // Clear session data and save changes
    req.session.facebookPages = undefined;
    
    // CRITICAL FIX: Assign pages to user using authenticated user ID
    try {
      let userId = null;
      
      // Primary method: Get user ID from authenticated user (most reliable)
      if (req.user && (req.user as any).id) {
        userId = (req.user as any).id;
        console.log(`✅ Using authenticated user ID: ${userId}`);
      }
      // Fallback: Check for user ID directly in the request body
      else if (req.body.userId) {
        userId = parseInt(req.body.userId);
        if (!isNaN(userId)) {
          console.log(`✅ Using user ID from request body: ${userId}`);
        }
      }
      // Final fallback: Extract from request headers
      else if (req.headers['x-user-id']) {
        userId = parseInt(req.headers['x-user-id'] as string);
        if (!isNaN(userId)) {
          console.log(`✅ Using user ID from headers: ${userId}`);
        }
      }
      else {
        console.error('❌ No authenticated user ID found - pages will not be assigned');
      }
      
      if (userId) {
        console.log(`✅ Assigning ${selectedPages.length} page(s) to user ID: ${userId}`);
        
        // For each page, create a user-page relationship
        for (const page of selectedPages) {
          try {
            await storage.assignPageToUser(userId, page.id);
            console.log(`✅ ASSIGNED page ${page.id} to user ${userId}`);
          } catch (error) {
            console.error(`❌ Failed to assign page ${page.id} to user ${userId}:`, error);
          }
        }
      } else {
        console.error('❌ CRITICAL: No user ID found - pages will NOT be assigned to any user!');
      }
    } catch (error) {
      console.error('Error assigning pages to user:', error);
    }
    
    req.session.save((err) => {
      if (err) {
        console.error('Error saving session after clearing pages:', err);
      }
      
      // Return success with redirect required flag
      res.json({ 
        success: true, 
        pagesConnected: selectedPages.length,
        refreshRequired: true  // Tell the frontend to refresh the entire app
      });
    });
  } catch (error: any) {
    console.error('Error connecting pages:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Endpoint to get Facebook pages stored in session after OAuth (fallback)
router.get('/session-pages', (req: Request, res: Response) => {
  if (!req.session.facebookPages) {
    return res.status(404).json({ success: false, message: 'No Facebook pages in session' });
  }
  
  res.json({ success: true, pages: req.session.facebookPages });
});

// Endpoint to get all available pages (non-authenticated)
router.get('/all-pages', async (req: Request, res: Response) => {
  try {
    const pages = await storage.getAllPages();
    res.json({ success: true, pages });
  } catch (error: any) {
    console.error('Error retrieving pages:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Exchange token endpoint - used for the fallback approach when SDK doesn't load
router.post('/exchange-token', async (req: Request, res: Response) => {
  try {
    const { accessToken } = req.body;
    
    if (!accessToken) {
      return res.status(400).json({ success: false, message: 'Access token is required' });
    }
    
    // Exchange short-lived token for a long-lived token
    const longLivedTokenResponse = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${FACEBOOK_APP_ID}&client_secret=${FACEBOOK_APP_SECRET}&fb_exchange_token=${accessToken}`);
    
    if (!longLivedTokenResponse.ok) {
      const errorText = await longLivedTokenResponse.text();
      throw new Error(`Failed to exchange for long-lived token: ${errorText}`);
    }
    
    const longLivedTokenData = await longLivedTokenResponse.json() as { access_token: string, expires_in: number };
    
    res.json({ success: true, accessToken: longLivedTokenData.access_token });
  } catch (error: any) {
    console.error('Token exchange error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Endpoint to subscribe a page to webhooks
router.post('/subscribe-webhook', async (req: Request, res: Response) => {
  try {
    const { pageId, accessToken } = req.body;
    
    if (!pageId || !accessToken) {
      return res.status(400).json({ success: false, message: 'Page ID and access token are required' });
    }
    
    // Subscribe the page to webhooks
    const webhookResponse = await fetch(`https://graph.facebook.com/v18.0/${pageId}/subscribed_apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken })
    });
    
    if (!webhookResponse.ok) {
      const errorText = await webhookResponse.text();
      throw new Error(`Failed to subscribe to webhooks: ${errorText}`);
    }
    
    const webhookData = await webhookResponse.json();
    
    res.json({ success: true, data: webhookData });
  } catch (error: any) {
    console.error('Webhook subscription error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;