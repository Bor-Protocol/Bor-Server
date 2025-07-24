import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { Op } from 'sequelize';
import sequelize from './config/database.js';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { Filter } from 'bad-words';
import * as badwordsList from 'badwords-list';
import { uploadAudioToBunnyCDN } from './upload/uploadCdn.js';
import { initDatabase } from './config/database.js';
import { 
  socketAuthMiddleware, 
  authenticateApiToken, 
  optionalAuth,
  requireAuth,
  checkAgentPermissions 
} from './middleware/auth-simple.js';

// Import models
import Comment from '../models/Comment.js';
import User from '../models/User.js';

// Initialize environment variables
dotenv.config();

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const JWT_EXPIRE = process.env.JWT_EXPIRE || '1h';
const REFRESH_TOKEN_EXPIRE = process.env.REFRESH_TOKEN_EXPIRE || '7d';
const BCRYPT_ROUNDS = 12;

const app = express();
const httpServer = createServer(app);

// Configure CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['*'],  // Allow all headers
  credentials: true
}));
app.use(express.json());

// Configure Socket.IO with CORS and authentication
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["*"],
    credentials: true
  }
});

// Apply authentication middleware to all socket connections
io.use(socketAuthMiddleware);

// Initialize counters
let commentCount = 0;

// Initialize database
initDatabase()
  .then(async () => {
    console.log('Connected to SQLite successfully');
    try {
      // Sync User model
      await User.sync();
      console.log('User model synchronized');
      
      commentCount = await Comment.count();
      const userCount = await User.count();
      console.log('Initial counts loaded - Comments:', commentCount, 'Users:', userCount);
    } catch (error) {
      console.error('Error initializing counts:', error);
    }
  })
  .catch(err => {
    console.error('Database initialization error:', err);
    process.exit(1);
  });

// Error handler middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

/******************************************* */

/*organize**************** */
//socket and stream infos
// Add this near the top where other state variables are defined
const agentViewers = new Map();

// Add near top with other state variables
const socketToStream = new Map();

// Helper function to emit stream counts
function emitStreamCounts() {
  const streamCounts = Object.fromEntries(
    Array.from(agentViewers.entries()).map(([agentId, viewers]) => [
      agentId,
      viewers.size
    ])
  );

  console.log('Emitting stream counts:', streamCounts);
  io.emit('stream_counts', streamCounts);
}

/*organize**************** */
//functionnalities
const filter = new Filter();

// Remove overly strict words from the filter
filter.removeWords(
  'poop',
  'gay',
  'hell',
  'damn',
  'god',
  'jesus',
  'crap',
  'darn',
  'idiot',
  'stupid',
  'dumb',
  'weird',
  'sucks',
  'wtf',
  'omg',
  'butt',
  'fart',
  'sexy',
  'sex',
  'hate',
  'drunk',
  'drugs',
  'drug',
  'faggot'
);



// Create a custom filter function
function filterProfanity(text) {
  // Get the bad words array from the list
  const badWords = badwordsList.array;
  
  // Convert text to lowercase for checking
  let filteredText = text;
  
  // Replace bad words with asterisks
  badWords.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    filteredText = filteredText.replace(regex, '*'.repeat(word.length));
  });
  
  return filteredText;
}
/******************** */

/*organize******************* */
//something related to agent works

// Add periodic ping to keep counts accurate
setInterval(() => {
  for (const [agentId, viewers] of agentViewers.entries()) {
    io.emit(`${agentId}_viewer_count`, { count: viewers.size });
  }
}, 5000); // Update every 5 seconds

// Add this function near the top where other state variables are defined
function getConnectedPeers() {
  return io.engine.clientsCount;
}

/*organize*************** */
//sockets
//emit

// Update the socket connection handler
io.on('connection', (socket) => {
  const userInfo = socket.user ? `${socket.user.email} (${socket.user.id})` : 'anonymous';
  console.log(`Client connected: ${socket.id} - User: ${userInfo}`);

  // Send initial state with user authentication status
  socket.emit('initial_state', {
    peerCount: getConnectedPeers(),
    commentCount,
    authenticated: socket.user?.isAuthenticated || false,
    user: socket.user ? { id: socket.user.id, email: socket.user.email } : null
  });

  io.emit('peer_count', { count: getConnectedPeers() });

  socket.on('request_peer_count', () => {
    socket.emit('peer_count', { count: getConnectedPeers() });
  });

  socket.on('new_comment', async (data) => {
    console.log('new_comment event received:', { socketId: socket.id, data });
    
    // Check authentication for commenting
    if (!requireAuth(socket, (error) => {
      socket.emit('comment_error', error);
    })) {
      return;
    }
    
    const { comment, agentId } = data;
    try {
      // Prevent duplicate processing
      const messageId = comment.id || Date.now().toString();
      const duplicateCheck = await Comment.findOne({ 
        where: { id: messageId }
      });
      
      if (duplicateCheck) {
        console.log('Duplicate comment detected, skipping:', messageId);
        return;
      }

      commentCount++;
      
      const filteredMessage = filterProfanity(comment.message);
      
      // Include authenticated user information
      const newComment = await Comment.create({
        id: messageId,
        message: filteredMessage,
        agentId,
        user: socket.user.email, // Use authenticated user email
        avatar: comment.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${socket.user.id}`,
        handle: comment.handle || socket.user.email.split('@')[0],
        userId: socket.user.id // Store user ID for tracking
      });

      io.emit('comment_received', { 
        newComment: newComment.toJSON(), 
        commentCount 
      });
      
      if (agentId) {
        io.emit(`${agentId}_comment_received`, { 
          newComment: newComment.toJSON(), 
          commentCount 
        });
      }
    } catch (error) {
      console.error('Error handling new_comment:', error);
      socket.emit('comment_error', { 
        success: false, 
        error: 'Failed to post comment' 
      });
    }
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });

  // Add these new socket event handlers
  socket.on('join_agent_stream', (agentId) => {
    // Authenticate users for joining agent streams
    if (!checkAgentPermissions(socket, agentId, (error) => {
      socket.emit('stream_join_error', error);
    })) {
      return;
    }

    const previousStream = socketToStream.get(socket.id);
    if (previousStream) {
      agentViewers.get(previousStream)?.delete(socket.id);
    }

    socketToStream.set(socket.id, agentId);
    if (!agentViewers.has(agentId)) {
      agentViewers.set(agentId, new Set());
    }
    agentViewers.get(agentId)?.add(socket.id);

    // Log authenticated user joining stream
    console.log(`User ${socket.user.email} joined agent ${agentId} stream`);

    emitStreamCounts(); // Emit updated counts to all clients
    
    // Confirm successful join
    socket.emit('stream_joined', { agentId, authenticated: true });
  });

  socket.on('leave_agent_stream', (agentId) => {
    // Remove this socket from the agent's viewers
    agentViewers.get(agentId)?.delete(socket.id);

    // Emit updated viewer count
    const viewerCount = agentViewers.get(agentId)?.size || 0;
    io.emit(`${agentId}_viewer_count`, { count: viewerCount });

    // Clean up empty sets
    if (viewerCount === 0) {
      agentViewers.delete(agentId);
    }

    // Log user leaving stream
    if (socket.user) {
      console.log(`User ${socket.user.email} left agent ${agentId} stream`);
    }
  });

  // Update the disconnect handler
  socket.on('disconnect', () => {
    const agentId = socketToStream.get(socket.id);
    if (agentId) {
      agentViewers.get(agentId)?.delete(socket.id);
      socketToStream.delete(socket.id);
      emitStreamCounts(); // Emit updated counts to all clients
    }
    
    const userInfo = socket.user ? `${socket.user.email} (${socket.user.id})` : 'anonymous';
    console.log(`Client disconnected: ${socket.id} - User: ${userInfo}`);
    
    // Emit updated peer count to all remaining clients
    io.emit('peer_count', { count: getConnectedPeers() });
  });
});

/******************** */

/*organize************** */
//authentication api endpoints
// Real database-backed authentication using User model

// User registration endpoint
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validate input
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Name, email, and password are required'
      });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters long'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ where: { email: email.toLowerCase() } });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: 'User with this email already exists'
      });
    }

    // Hash password with bcrypt
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Create new user in database
    const userId = Date.now().toString();
    const user = await User.create({
      id: userId,
      name: name.trim(),
      email: email.toLowerCase(),
      password: hashedPassword,
      points: 100,
      user_type: 'user',
      subscription_tier: 'free',
      is_active: true,
      email_verified: false,
      auth_provider: 'local',
      total_sessions: 0,
      points_next_regen: new Date(Date.now() + 24 * 60 * 60 * 1000),
      last_login: new Date()
    });

    // Generate real JWT tokens
    const payload = {
      userId: user.id,
      email: user.email,
      userType: user.user_type
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRE });
    const refreshToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRE });

    // Remove password from response
    const { password: _, ...userResponse } = user.toJSON();

    res.status(201).json({
      success: true,
      user: userResponse,
      token,
      refreshToken
    });

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during signup'
    });
  }
});

// User login endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    // Find user in database (debug logging)
    console.log(`Login attempt for email: ${email.toLowerCase()}`);
    const user = await User.findOne({ where: { email: email.toLowerCase() } });
    
    if (!user) {
      console.log(`User not found for email: ${email.toLowerCase()}`);
      // Check if user exists with different case
      const userAnyCase = await User.findOne({ 
        where: sequelize.where(
          sequelize.fn('LOWER', sequelize.col('email')), 
          email.toLowerCase()
        )
      });
      if (userAnyCase) {
        console.log(`Found user with different case: ${userAnyCase.email}`);
      }
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    console.log(`User found: ${user.email}, checking password...`);
    
    // Handle users who might not have bcrypt passwords (legacy or test users)
    if (!user.password) {
      console.log('User has no password set');
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Verify password with bcrypt
    const isPasswordValid = await bcrypt.compare(password, user.password);
    console.log(`Password validation result: ${isPasswordValid}`);
    
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Check if account is active
    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        error: 'Account is deactivated. Please contact support.'
      });
    }

    // Generate real JWT tokens
    const payload = {
      userId: user.id,
      email: user.email,
      userType: user.user_type
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRE });
    const refreshToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRE });

    // Update last login and session count in database
    await user.update({
      last_login: new Date(),
      total_sessions: user.total_sessions + 1
    });

    // Remove password from response
    const { password: _, ...userResponse } = user.toJSON();

    res.json({
      success: true,
      user: userResponse,
      token,
      refreshToken
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during login'
    });
  }
});

// Token refresh endpoint
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(403).json({
        success: false,
        error: 'Refresh token is required'
      });
    }

    // Verify refresh token
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, JWT_SECRET);
    } catch (jwtError) {
      return res.status(403).json({
        success: false,
        error: 'Invalid or expired refresh token'
      });
    }

    // Find user by ID from token in database
    const user = await User.findByPk(decoded.userId);
    if (!user) {
      return res.status(403).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check if account is still active
    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        error: 'Account is deactivated'
      });
    }

    // Generate new tokens
    const payload = {
      userId: user.id,
      email: user.email,
      userType: user.user_type
    };

    const newToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRE });
    const newRefreshToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRE });

    // Update last activity in database
    await user.update({ last_login: new Date() });

    // Remove password from response
    const { password: _, ...userResponse } = user.toJSON();

    res.json({
      success: true,
      user: userResponse,
      token: newToken,
      refreshToken: newRefreshToken
    });

  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during token refresh'
    });
  }
});

// Get current user endpoint
app.get('/api/auth/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired access token'
      });
    }

    // Find user by ID from token in database
    const user = await User.findByPk(decoded.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check if account is still active
    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        error: 'Account is deactivated'
      });
    }

    // Remove password from response
    const { password: _, ...userResponse } = user.toJSON();

    res.json({
      success: true,
      user: userResponse
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Spend points endpoint
app.post('/api/users/spend-points', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired access token'
      });
    }

    const { amount, reason } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount'
      });
    }

    // Find user by ID from token in database
    const user = await User.findByPk(decoded.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check if account is active
    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        error: 'Account is deactivated'
      });
    }

    if (user.points < amount) {
      return res.status(400).json({
        success: false,
        error: 'Insufficient points'
      });
    }

    // Update user points in database
    await user.update({ 
      points: user.points - amount 
    });

    // Log transaction
    console.log(`Points transaction: User ${user.email} spent ${amount} points. Reason: ${reason || 'Not specified'}. New balance: ${user.points - amount}`);

    res.json({
      success: true,
      newBalance: user.points - amount,
      transaction: {
        amount,
        reason: reason || 'Points spent',
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Spend points error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Debug endpoint to check users (remove in production)
app.get('/api/debug/users', async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: ['id', 'name', 'email', 'auth_provider', 'createdAt', 'last_login'],
      order: [['createdAt', 'DESC']],
      limit: 10
    });
    
    res.json({
      success: true,
      count: users.length,
      users: users.map(user => ({
        ...user.toJSON(),
        hasPassword: !!user.password
      }))
    });
  } catch (error) {
    console.error('Debug users error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch users'
    });
  }
});

// Google OAuth endpoint
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential, googleUser } = req.body;

    if (!googleUser || !googleUser.email) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Google user data'
      });
    }

    const email = googleUser.email.toLowerCase();
    let user = await User.findOne({ where: { email } });
    let isNewUser = false;

    if (!user) {
      // Create new user from Google data
      const userId = Date.now().toString();
      user = await User.create({
        id: userId,
        name: googleUser.name || googleUser.email.split('@')[0],
        email: email,
        password: null, // OAuth users don't have passwords
        google_id: googleUser.id,
        avatar: googleUser.picture,
        points: 100,
        user_type: 'user',
        subscription_tier: 'free',
        is_active: true,
        email_verified: googleUser.email_verified || true,
        auth_provider: 'google',
        total_sessions: 0,
        points_next_regen: new Date(Date.now() + 24 * 60 * 60 * 1000),
        last_login: new Date()
      });
      
      isNewUser = true;
      console.log(`New Google user created: ${email}`);
    } else {
      // Update existing user's Google data
      await user.update({
        google_id: googleUser.id,
        avatar: googleUser.picture,
        email_verified: true,
        auth_provider: 'google',
        total_sessions: user.total_sessions + 1,
        last_login: new Date()
      });
      
      console.log(`Existing user logged in via Google: ${email}`);
    }

    // Generate real JWT tokens
    const payload = {
      userId: user.id,
      email: user.email,
      userType: user.user_type,
      authProvider: 'google'
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRE });
    const refreshToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRE });

    // Remove password from response
    const { password: _, ...userResponse } = user.toJSON();

    res.json({
      success: true,
      user: userResponse,
      token,
      refreshToken,
      isNewUser
    });

  } catch (error) {
    console.error('Google OAuth error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during Google authentication'
    });
  }
});

/*organize************** */
//api works : 
app.get('/api/streams/:agentId/unread-comments', async (req, res) => {
  try {
    const { agentId } = req.params;
    const limit = parseInt(req.query.limit) || 10;
    
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    
    const comments = await Comment.findAll({
      where: {
        readByAgent: false,
        createdAt: {
          [Op.gte]: fifteenMinutesAgo
        }
      },
      order: [['createdAt', 'DESC']],
      limit: 1
    });

    res.json({ 
      comments,
      metadata: {
        count: comments.length,
        since: fifteenMinutesAgo.toISOString(),
        hasMore: comments.length >= limit
      }
    });
  } catch (error) {
    console.error('Error fetching unread comments:', error);
    res.status(500).json({ error: 'Failed to fetch unread comments' });
  }
});

// Needs some testing from borp-client to see if it works
app.post('/api/upload/audio', async (req, res) => {
  try {
    // check if req is the audio stream
    console.log('TESTING IF THIS IS BEING CALLED');
    if (req.headers['isAudioStream'] !== 'true' && req.headers['content-type'] !== 'audio/mpeg') {
      return res.status(400).json({ error: 'Not an audio stream' });
    }
    const audioBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', (err) => reject(err));
    });
    const url = await uploadAudioToBunnyCDN(audioBuffer);
    res.json({ message: 'Upload successful', url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stats endpoints
app.get('/api/streams/:agentId/stats', async (req, res) => {
  const agentId = req.params.agentId;
  try {
    const comments = await Comment.count({ where: { agentId } });
    console.log({ comments, agentId });
    res.json({ comments });
  } catch (error) {
    console.error('Error in /api/streams/:agentId/stats:', error);
    res.status(500).json({ error: 'Failed to get stream stats' });
  }
});

/*organize************** */
//sockets
//emit

// Update the chat history endpoint
app.get('/api/agents/:agentId/chat-history', async (req, res) => {
  try {
    const { agentId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before ? new Date(req.query.before) : new Date();

    // Fetch comments and AI responses in parallel
    const [comments] = await Promise.all([
      Comment.findAll({
        where: {
          agentId,
          createdAt: { [Op.lt]: before }
        },
        order: [['createdAt', 'DESC']],
        limit,
        raw: true
      })
    ]);

    // Transform and combine the results
    const chatHistory = [
      ...comments.map(c => ({
        id: c.id,
        type: 'comment',
        message: c.message,
        createdAt: c.createdAt,
        sender: c.user,
        handle: c.handle,
        avatar: c.avatar
      }))
    ];

    // Sort by creation date, newest first
    chatHistory.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Trim to requested limit
    const trimmedHistory = chatHistory.slice(0, limit);

    res.json({
      chatHistory: trimmedHistory,
      pagination: {
        hasMore: chatHistory.length >= limit,
        oldestMessageDate: trimmedHistory[trimmedHistory.length - 1]?.createdAt
      }
    });

  } catch (error) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

/*organize************** */
//eliza package use
// Animation and Expression endpoints
app.post('/api/update-animation', async (req, res) => {
  // Check API key
  // const apiKey = req.headers['api_key'];
  // if (apiKey !== API_KEY) {
  //   console.log('Invalid API key', apiKey, 'expected:', API_KEY, { headers: req?.headers });
  //   return res.status(401).json({ error: 'Invalid API key' });
  // }

  try {
    console.log('update-animation', req.body);
    const animation = req.body.animation;
    const agentId = req.body.agentId;
    console.log(`Requested animation: ${animation} for agentId: ${agentId}`);

    io.emit('update_animation', animation);

    if (agentId) {
      io.emit(`${agentId}_update_animation`, animation);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating animation:', error);
    res.status(500).json({ error: error.message });
  }
});

// a voir maybe we deleted
app.post('/api/ai-responses', async (req, res) => {
  // Check API key
  // const apiKey = req.headers['api_key'];
  // if (apiKey !== API_KEY) {
  //   console.log('Invalid API key', apiKey, 'expected:', API_KEY, { headers: req?.headers });
  //   return res.status(401).json({ error: 'Invalid API key' });
  // }

  const { agentId, ...requestBody } = req.body;
  try {

    console.log('ai-responses', req.body);

   
    // Get user profile if replyToUser is provided
    let handle;
    let pfp;

    if (requestBody.replyToUser) {
      try {
        // UserProfile model not implemented yet, skip for now
        handle = requestBody.replyToUser;
        pfp = null;
      } catch (error) {
        console.error('Error fetching user profile:', error);
        // Continue execution without the profile info rather than failing the whole request
      }
    }

    // // Emit animation update if provided
    // if (requestBody.animation) {
    //   console.log('AI_RESPONSE: EMIT update_animation', { agentId, requestBody });
    //   if (agentId) {
    //     io.emit(`${agentId}_update_animation`, requestBody.animation);
    //   } else {
    //     io.emit('update_animation', requestBody.animation);
    //   }
    // }

    // // Emit audio response if provided
    // if (requestBody.audioUrl) {
    //   console.log('AI_RESPONSE: EMIT audio_response', { agentId, audioUrl: requestBody.audioUrl });
    //   io.emit(`${agentId}_audio_response`, {
    //     messageId: requestBody.id,
    //     audioUrl: requestBody.audioUrl
    //   });
    // }

    // Emit response with appropriate channel
    if (!agentId) {
      io.emit('ai_response', {
        id: requestBody.id,
        agentId: agentId || undefined,
        // aiResponse: savedResponse,
        text: requestBody.text,
        animation: requestBody.animation,
        handle,
        pfp,
        replyToUser: requestBody.replyToUser,
        replyToMessageId: requestBody.replyToMessageId,
        replyToMessage: requestBody.replyToMessage,
        replyToHandle: requestBody.replyToHandle,
        replyToPfp: requestBody.replyToPfp,
        isGiftResponse: requestBody.isGiftResponse,
        giftId: requestBody.giftId,
        audioUrl: requestBody.audioUrl,
        thought: requestBody.thought,
      });
    } else {
      console.log('EMIT ai_response', { agentId, requestBody });
      io.emit(`${agentId}_ai_response`, {
        id: requestBody.id,
        agentId,
        // aiResponse: savedResponse,
        text: requestBody.text,
        animation: requestBody.animation,
        handle,
        pfp,
        replyToUser: requestBody.replyToUser,
        replyToMessageId: requestBody.replyToMessageId,
        replyToMessage: requestBody.replyToMessage,
        replyToHandle: requestBody.replyToHandle,
        replyToPfp: requestBody.replyToPfp,
        isGiftResponse: requestBody.isGiftResponse,
        giftId: requestBody.giftId,
        audioUrl: requestBody.audioUrl,
        thought: requestBody.thought,
      });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error generating AI response:', error);
    res.status(500).json({ error: error.message });
  }
});

//mark comment as read method + url

async function markCommentsAsRead(commentIds) {
  try {
    const result = await Comment.update(
      { readByAgent: true },
      {
        where: {
          id: { [Op.in]: commentIds }
        }
      }
    );

    if (result[0] === 0) {
      return { success: false, error: 'No comments found' };
    }

    return {
      success: true,
      modifiedCount: result[0]
    };
  } catch (error) {
    console.error('Error marking comments as read:', error);
    return { success: false, error: 'Failed to mark comments as read' };
  }
}
app.post('/api/comments/mark-read', authenticateApiToken, async (req, res) => {
  try {
    const { commentIds } = req.body;

    if (!Array.isArray(commentIds)) {
      return res.status(400).json({ error: 'commentIds must be an array' });
    }

    const result = await markCommentsAsRead(commentIds);
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({
      success: true,
      modifiedCount: result.modifiedCount,
      user: req.user.email // Include authenticated user info
    });
  } catch (error) {
    console.error('Error marking comments as read:', error);
    res.status(500).json({ error: 'Failed to mark comments as read' });
  }
});



/*organize************** */
//server looking out
// Graceful shutdown
const gracefulShutdown = () => {
  console.log('Received shutdown signal');
  io.emit('server_shutdown', { message: 'Server is shutting down' });
  io.close(() => {
    console.log('All socket connections closed');
    process.exit(0);
  });
};
//process
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Start server
const PORT = process.env.PORT || 6969;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server available at ws://localhost:${PORT}`);
  console.log('Accepting connections from all origins');
});

/******************** */