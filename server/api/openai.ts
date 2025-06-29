import OpenAI from 'openai';
import { log } from '../vite';

// Global instance
let openaiClient: OpenAI | null = null;

/**
 * Initialize the OpenAI client
 * This should be called at startup and whenever the API key is updated
 */
export async function initializeOpenAIConfig(): Promise<boolean> {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    
    if (!apiKey) {
      log('OPENAI_API_KEY environment variable is not set', 'openai');
      return false;
    }
    
    // Display a masked version of the key for debugging
    const maskedKey = `${apiKey.substring(0, 5)}...${apiKey.substring(apiKey.length - 4)}`;
    console.log(`OpenAI configuration initialized with key: ${maskedKey}`);
    
    openaiClient = new OpenAI({
      apiKey
    });
    
    return true;
  } catch (error) {
    console.error('Error initializing OpenAI client:', error);
    return false;
  }
}

/**
 * Generate a response using the OpenAI API
 * This is a fallback for when the Python bridge is not available
 * 
 * @param message The user's message
 * @param assistantId The assistant ID to use, if available
 * @returns The generated response
 */
export async function generateResponse(message: string, assistantId: string = 'default'): Promise<string> {
  try {
    if (!openaiClient) {
      const initialized = await initializeOpenAIConfig();
      if (!initialized) {
        throw new Error('OpenAI client is not initialized');
      }
    }
    
    log(`Generating response for message: "${message.substring(0, 30)}..." with assistant ${assistantId}`, 'openai');
    
    // Use the gpt-4o-mini model (newest available)
    const response = await openaiClient!.chat.completions.create({
      model: "gpt-4o-mini", // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
      messages: [
        {
          role: "system",
          content: getSystemPromptForAssistant(assistantId)
        },
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0.7,
      max_tokens: 500
    });
    
    const generatedText = response.choices[0].message.content?.trim() || 'Sorry, I could not generate a response.';
    log(`Generated response: "${generatedText.substring(0, 30)}..."`, 'openai');
    
    return generatedText;
  } catch (error) {
    console.error('Error generating response with OpenAI:', error);
    throw error;
  }
}

/**
 * Get a system prompt for a specific assistant ID
 * This helps personalize the behavior for different pages
 */
function getSystemPromptForAssistant(assistantId: string): string {
  // Default system prompt
  const defaultPrompt = 
    "You are a helpful customer service assistant. Respond to user queries in a friendly, helpful manner. " +
    "Keep responses concise and to the point. If you don't know the answer to something, be honest about it.";
  
  // Special prompts for specific assistants
  const assistantPrompts: Record<string, string> = {
    // Example custom assistant behaviors
    'counselor': 
      "You are an empathetic mental health assistant. Respond with compassion and understanding. " +
      "Your primary role is to listen and provide supportive responses, not to diagnose or treat conditions. " +
      "Always encourage users to seek professional help for serious concerns.",
    
    'tech_support': 
      "You are a technical support assistant. Help users troubleshoot common problems with their devices and software. " +
      "Ask clarifying questions when needed. Provide step-by-step instructions. " +
      "Be patient with users who may not be technically proficient.",
    
    'sales': 
      "You are a friendly sales assistant. Help customers find products that meet their needs. " +
      "Ask questions to understand their requirements better. Highlight product benefits, not just features. " +
      "Never be pushy, but gently guide customers toward making an informed purchase decision."
  };
  
  // If assistantId appears to be a real OpenAI assistant ID (starts with "asst_")
  if (assistantId && assistantId.startsWith('asst_')) {
    log(`Using OpenAI assistant ID: ${assistantId}`, 'openai');
    
    // Try to fetch the instructions from a config file, environment, or database
    // This is a fallback for when we can't directly load the assistant from the API
    try {
      // You could implement a mapping here to store assistant instructions
      // For now, use a generic prompt that acknowledges we're using a specific assistant
      return `You are acting as a specific OpenAI assistant (ID: ${assistantId}). Respond to user queries in a helpful, friendly manner that matches the style and expertise expected of this assistant.`;
    } catch (error) {
      console.error(`Error getting instructions for assistant ${assistantId}:`, error);
    }
  }
  
  // Return custom prompt if it exists, otherwise return default
  return assistantPrompts[assistantId] || defaultPrompt;
}