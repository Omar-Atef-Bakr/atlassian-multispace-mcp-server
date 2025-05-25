// index.js - Works directly on Replit
const express = require('express');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const axios = require('axios');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple in-memory session store (fine for testing)
const sessions = new Map();

app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true, // Replit uses HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// CORS for Claude
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://claude.ai');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Home page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Multi-Space Jira MCP</title>
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
          max-width: 600px; 
          margin: 50px auto; 
          padding: 20px;
          background: #f5f5f5;
        }
        .container {
          background: white;
          padding: 30px;
          border-radius: 10px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .button { 
          background: #0052CC; 
          color: white; 
          padding: 12px 24px; 
          text-decoration: none; 
          border-radius: 5px; 
          display: inline-block;
          font-weight: 500;
          margin: 20px 0;
        }
        .button:hover {
          background: #0747A6;
        }
        code { 
          background: #f4f4f4; 
          padding: 2px 6px; 
          border-radius: 3px;
          font-family: 'Courier New', monospace;
        }
        .step {
          margin: 15px 0;
          padding-left: 20px;
        }
        h1 { color: #172B4D; }
        h2 { color: #42526E; margin-top: 30px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🔗 Multi-Space Jira MCP Server</h1>
        <p>Connect Claude to multiple Jira spaces with a single authentication!</p>
        
        <a href="/auth/start" class="button">Connect to Jira →</a>
        
        <h2>Setup Instructions:</h2>
        <div class="step">1️⃣ Click "Connect to Jira" above</div>
        <div class="step">2️⃣ Log in with your Atlassian account</div>
        <div class="step">3️⃣ Copy the generated URL</div>
        <div class="step">4️⃣ Add it to Claude's MCP integrations</div>
        
        <h2>Available Tools:</h2>
        <ul>
          <li><code>search_issues_across_spaces</code> - Search in all your Jira spaces</li>
          <li><code>create_issue</code> - Create issues in any space</li>
          <li><code>list_spaces</code> - See all accessible spaces</li>
        </ul>
        
        <p style="margin-top: 40px; color: #6B778C; font-size: 14px;">
          Note: You'll need to set up Atlassian OAuth credentials in Replit secrets.
        </p>
      </div>
    </body>
    </html>
  `);
});

// Start OAuth
app.get('/auth/start', (req, res) => {
  // Check if OAuth is configured
  if (!process.env.ATLASSIAN_CLIENT_ID) {
    return res.send(`
      <html>
      <body style="font-family: Arial; padding: 20px; max-width: 600px; margin: 0 auto;">
        <h2>⚠️ OAuth Not Configured</h2>
        <p>To use this server, you need to set up Atlassian OAuth:</p>
        <ol>
          <li>Go to <a href="https://developer.atlassian.com/console/myapps/" target="_blank">Atlassian Developer Console</a></li>
          <li>Create a new app</li>
          <li>Add OAuth 2.0 (3LO) integration</li>
          <li>Set callback URL to: <code>${req.protocol}://${req.get('host')}/auth/callback</code></li>
          <li>In Replit, go to Secrets (🔒) and add:
            <ul>
              <li><code>ATLASSIAN_CLIENT_ID</code></li>
              <li><code>ATLASSIAN_CLIENT_SECRET</code></li>
            </ul>
          </li>
          <li>Restart the Repl and try again!</li>
        </ol>
      </body>
      </html>
    `);
  }
  
  const state = crypto.randomBytes(16).toString('hex');
  sessions.set(state, { created: Date.now() });
  
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: process.env.ATLASSIAN_CLIENT_ID,
    scope: 'read:jira-work write:jira-work read:jira-user offline_access',
    redirect_uri: `${req.protocol}://${req.get('host')}/auth/callback`,
    state: state,
    response_type: 'code',
    prompt: 'consent'
  });
  
  res.redirect(`https://auth.atlassian.com/authorize?${params}`);
});

// OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  
  if (!sessions.has(state)) {
    return res.status(400).send('Invalid state');
  }
  
  sessions.delete(state); // Use once
  
  try {
    // Get token
    const tokenResponse = await axios.post('https://auth.atlassian.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: process.env.ATLASSIAN_CLIENT_ID,
      client_secret: process.env.ATLASSIAN_CLIENT_SECRET,
      code,
      redirect_uri: `${req.protocol}://${req.get('host')}/auth/callback`
    });
    
    const { access_token } = tokenResponse.data;
    
    // Get accessible resources
    const resourcesRes = await axios.get('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    
    if (resourcesRes.data.length === 0) {
      return res.status(400).send('No Jira sites found');
    }
    
    const site = resourcesRes.data[0];
    const cloudId = site.id;
    
    // Get projects
    const projectsRes = await axios.get(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    
    // Create session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    sessions.set(sessionToken, {
      token: access_token,
      cloudId,
      url: site.url,
      spaces: projectsRes.data.map(p => p.key),
      created: Date.now()
    });
    
    const mcpUrl = `${req.protocol}://${req.get('host')}/v1/sse?token=${sessionToken}`;
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Success!</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
            max-width: 600px; 
            margin: 50px auto; 
            padding: 20px;
          }
          .success-box {
            background: #00875A;
            color: white;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
          }
          .url-container {
            background: #f4f4f4;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            word-break: break-all;
          }
          .copy-btn {
            background: #0052CC;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 14px;
          }
          .copy-btn:hover {
            background: #0747A6;
          }
          code {
            font-family: 'Courier New', monospace;
            font-size: 14px;
          }
        </style>
      </head>
      <body>
        <div class="success-box">
          <h2>✅ Successfully Connected!</h2>
          <p>Found ${projectsRes.data.length} accessible Jira projects</p>
        </div>
        
        <h3>Your MCP Connection URL:</h3>
        <div class="url-container">
          <code id="url">${mcpUrl}</code>
          <button class="copy-btn" onclick="copyUrl()">Copy URL</button>
        </div>
        
        <h3>Next Steps:</h3>
        <ol>
          <li>Copy the URL above</li>
          <li>Go to <a href="https://claude.ai" target="_blank">claude.ai</a></li>
          <li>Click your profile → Feature Preview → Model Context Protocol</li>
          <li>Click "Add MCP Integration"</li>
          <li>Paste the URL and save</li>
        </ol>
        
        <p style="color: #6B778C; margin-top: 30px;">
          Accessible spaces: ${projectsRes.data.map(p => p.key).join(', ')}
        </p>
        
        <script>
          function copyUrl() {
            const url = document.getElementById('url').textContent;
            navigator.clipboard.writeText(url).then(() => {
              alert('URL copied!');
            });
          }
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Auth error:', error.response?.data || error);
    res.status(500).send('Authentication failed: ' + error.message);
  }
});

// SSE endpoint for MCP
app.get('/v1/sse', async (req, res) => {
  const token = req.query.token;
  const session = sessions.get(token);
  
  if (!session) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  
  // Create MCP server
  const mcpServer = new Server(
    { name: 'multi-space-jira', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  
  // Jira API helper
  const jiraApi = async (endpoint, options = {}) => {
    return axios({
      url: `https://api.atlassian.com/ex/jira/${session.cloudId}/rest/api/3${endpoint}`,
      headers: {
        Authorization: `Bearer ${session.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      ...options
    });
  };
  
  // Register tools
  mcpServer.setRequestHandler({ method: 'tools/list' }, async () => ({
    tools: [
      {
        name: 'search_issues_across_spaces',
        description: 'Search issues in all accessible Jira spaces',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search text' },
            maxResults: { type: 'number', default: 20 }
          },
          required: ['query']
        }
      },
      {
        name: 'create_issue',
        description: 'Create a new issue',
        inputSchema: {
          type: 'object',
          properties: {
            projectKey: { type: 'string' },
            summary: { type: 'string' },
            description: { type: 'string' },
            issueType: { type: 'string', default: 'Task' }
          },
          required: ['projectKey', 'summary']
        }
      },
      {
        name: 'list_spaces',
        description: 'List all accessible spaces',
        inputSchema: { type: 'object', properties: {} }
      }
    ]
  }));
  
  // Handle tool calls
  mcpServer.setRequestHandler({ method: 'tools/call' }, async (request) => {
    const { name, arguments: args } = request.params;
    
    try {
      switch (name) {
        case 'search_issues_across_spaces': {
          const jql = `text ~ "${args.query}" ORDER BY created DESC`;
          const res = await jiraApi('/search', {
            method: 'GET',
            params: { jql, maxResults: args.maxResults || 20 }
          });
          
          const issues = res.data.issues.map(issue => ({
            key: issue.key,
            summary: issue.fields.summary,
            status: issue.fields.status.name,
            project: issue.fields.project.key,
            url: `${session.url}/browse/${issue.key}`
          }));
          
          return {
            content: [{
              type: 'text',
              text: issues.length > 0 
                ? `Found ${issues.length} issues:\n\n${JSON.stringify(issues, null, 2)}`
                : 'No issues found matching your search.'
            }]
          };
        }
        
        case 'create_issue': {
          const res = await jiraApi('/issue', {
            method: 'POST',
            data: {
              fields: {
                project: { key: args.projectKey },
                summary: args.summary,
                description: {
                  type: 'doc',
                  version: 1,
                  content: [{
                    type: 'paragraph',
                    content: [{ type: 'text', text: args.description || '' }]
                  }]
                },
                issuetype: { name: args.issueType || 'Task' }
              }
            }
          });
          
          return {
            content: [{
              type: 'text',
              text: `Created issue: ${res.data.key}\nURL: ${session.url}/browse/${res.data.key}`
            }]
          };
        }
        
        case 'list_spaces': {
          return {
            content: [{
              type: 'text',
              text: `Accessible spaces: ${session.spaces.join(', ')}`
            }]
          };
        }
        
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error: ${error.response?.data?.errorMessages?.join(', ') || error.message}`
        }]
      };
    }
  });
  
  // Connect transport
  const transport = new SSEServerTransport('/', res);
  await mcpServer.connect(transport);
  
  // Keep alive
  const keepAlive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30000);
  
  req.on('close', () => {
    clearInterval(keepAlive);
    transport.close();
  });
});

// Clean up old sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessions.entries()) {
    if (now - value.created > 24 * 60 * 60 * 1000) {
      sessions.delete(key);
    }
  }
}, 60 * 60 * 1000); // Every hour

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});