import { storage } from './storage';
import { log } from './vite';
import path from 'path';
import { execSync } from 'child_process';
import fs from 'fs';
import { pages, users } from '@shared/schema';

/**
 * Initialize default admin and user accounts
 */
export async function initializeDefaultUsers() {
  try {
    // Create admin user if it doesn't exist
    const adminEmail = 'admin@example.com';
    const existingAdmin = await storage.getUserByEmail(adminEmail);
    
    if (!existingAdmin) {
      log('Creating default admin user', 'init-db');
      await storage.createUser({
        username: 'admin',
        email: adminEmail,
        password: 'admin123', // In production, this would be hashed
        role: 'admin',
        isAdmin: true
      });
      log('Default admin user created successfully', 'init-db');
    } else {
      log('Admin user already exists', 'init-db');
    }
    
    // Create regular user if it doesn't exist
    const userEmail = 'user@example.com';
    const existingUser = await storage.getUserByEmail(userEmail);
    
    if (!existingUser) {
      log('Creating default regular user', 'init-db');
      await storage.createUser({
        username: 'user',
        email: userEmail,
        password: 'user123', // In production, this would be hashed
        role: 'member',
        isAdmin: false
      });
      log('Default regular user created successfully', 'init-db');
    } else {
      log('Regular user already exists', 'init-db');
    }
    
    return true;
  } catch (error) {
    log(`Error initializing default users: ${error}`, 'init-db');
    return false;
  }
}

/**
 * Initialize database with pages from Python config
 */
export async function initializeDatabaseFromConfig() {
  try {
    // First, ensure default users exist
    await initializeDefaultUsers();
    
    // Since we removed hardcoded configurations, skip the Python config initialization
    // All pages will now be created through OAuth connections only
    log('Skipping hardcoded config initialization - using database-only approach', 'init-db');
    
    const result = {
      success: true,
      pages: [] // No hardcoded pages to initialize
    };

    const { pages } = result;
    
    // For each page from config, check if it exists in the database
    // If not, create it
    for (const pageConfig of pages) {
      const existingPage = await storage.getPageByPageId(pageConfig.pageId);
      
      if (!existingPage) {
        log(`Creating page with ID ${pageConfig.pageId} in database`, 'init-db');
        const newPage = await storage.createPage({
          pageId: pageConfig.pageId,
          name: pageConfig.name,
          platform: pageConfig.platform as 'Facebook' | 'Instagram',
          accessToken: pageConfig.accessToken,
          assistantId: pageConfig.assistantId
        });
        log(`Page with ID ${pageConfig.pageId} created successfully`, 'init-db');
        
        // Assign the page to the admin user
        const adminUser = await storage.getUserByEmail('admin@example.com');
        if (adminUser) {
          await storage.assignPageToUser(adminUser.id, pageConfig.pageId);
          log(`Page ${pageConfig.pageId} assigned to admin user`, 'init-db');
        }
      } else {
        log(`Page with ID ${pageConfig.pageId} already exists in database`, 'init-db');
        
        // Make sure the admin user has access to all pages
        const adminUser = await storage.getUserByEmail('admin@example.com');
        if (adminUser) {
          const isAuthorized = await storage.isUserAuthorizedForPage(adminUser.id, pageConfig.pageId);
          if (!isAuthorized) {
            await storage.assignPageToUser(adminUser.id, pageConfig.pageId);
            log(`Page ${pageConfig.pageId} assigned to admin user`, 'init-db');
          }
        }
      }
    }
    
    log('Database initialization from config completed successfully', 'init-db');
    return true;
  } catch (error) {
    log(`Error initializing database from config: ${error}`, 'init-db');
    return false;
  }
}