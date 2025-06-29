/**
 * Utility for connecting to Python API endpoints
 * Handles environment-specific URL configuration to work in both local and production
 */

import { log } from '../vite';

/**
 * Gets the base URL for Python API requests
 * This enables code to work in both development and production environments
 * 
 * @returns The base URL for Python API requests
 */
export function getPythonApiBaseUrl(): string {
  // Check for environment variables first
  if (process.env.PYTHON_API_URL) {
    return process.env.PYTHON_API_URL;
  }
  
  // Use environment-aware URL handling
  // When running in production, use a relative path that will be handled by the same host
  // In development, use localhost with the default port
  return process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5000';
}

/**
 * Gets the full URL for a Python API endpoint
 * 
 * @param endpoint The API endpoint path (e.g., '/api/insights')
 * @returns The full URL for the Python API endpoint
 */
export function getPythonApiUrl(endpoint: string): string {
  const baseUrl = getPythonApiBaseUrl();
  const fullUrl = `${baseUrl}${endpoint}`;
  
  // Log the URL being used for debugging
  log(`Using Python API URL: ${fullUrl}`, 'python-api');
  
  return fullUrl;
}