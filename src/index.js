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
  requireAuthForComment,
  checkAgentPermissions 
} from './middleware/auth-simple.js';

// Import models
import Comment from '../models/Comment.js';
import User from '../models/User.js';
import Transaction from '../models/Transaction.js';
import Session from '../models/Session.js';

// Initialize environment variables
dotenv.config();

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const JWT_EXPIRE = process.env.JWT_EXPIRE || '1h';
const REFRESH_TOKEN_EXPIRE = process.env.REFRESH_TOKEN_EXPIRE || '7d';
const BCRYPT_ROUNDS = 12;

// Session Configuration
const PRIVATE_SESSION_DURATION_MINUTES = parseInt(process.env.PRIVATE_SESSION_DURATION_MINUTES) || 1;
const SESSION_WARNING_MINUTES = parseFloat(process.env.SESSION_WARNING_MINUTES) || 0.5;

// Model Access Configuration
const FREE_MODEL_AGENT_ID = process.env.FREE_MODEL_AGENT_ID || '795df77f-1620-07db-bd9a-0e2dfefef248';

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
      // Sync all models
      await User.sync();
      await Transaction.sync();
      await Session.sync();
      console.log('All models synchronized');
      
      commentCount = await Comment.count();
      const userCount = await User.count();
      console.log('Initial counts loaded - Comments:', commentCount, 'Users:', userCount);
      
      // Start points regeneration system
      startPointsRegenerationSystem();
      
      // Clean up expired sessions
      await cleanupExpiredSessions();
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
const authenticatedUsers = new Map(); // Track authenticated users: userId -> Set of socketIds

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
//points economy system

// Points configuration
const POINTS_CONFIG = {
  DAILY_REGEN_AMOUNT: 50,
  MAX_POINTS: 200,
  PRIVATE_SESSION_COST: 10,
  REGEN_CHECK_INTERVAL: 60 * 1000, // Check every minute
};

// Create a transaction record
async function createTransaction(userId, type, amount, description, relatedId = null) {
  try {
    const user = await User.findByPk(userId);
    if (!user) throw new Error('User not found');

    const balanceBefore = user.points;
    const balanceAfter = type === 'spend' ? balanceBefore - amount : balanceBefore + amount;

    const transaction = await Transaction.create({
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      userId,
      type,
      amount,
      description,
      relatedId,
      balanceBefore,
      balanceAfter
    });

    console.log(`Transaction created: ${type} ${amount} points for user ${user.email} (${balanceBefore} → ${balanceAfter})`);
    return transaction;
  } catch (error) {
    console.error('Error creating transaction:', error);
    throw error;
  }
}

// Regenerate points for a user
async function regenerateUserPoints(user) {
  try {
    const now = new Date();
    const lastRegen = user.points_next_regen;
    
    // Check if regeneration is due
    if (lastRegen && now < lastRegen) {
      return false; // Not time yet
    }

    const currentPoints = user.points;
    const maxPoints = POINTS_CONFIG.MAX_POINTS;
    
    if (currentPoints >= maxPoints) {
      // User already at max, just update next regen time
      await user.update({
        points_next_regen: new Date(now.getTime() + 24 * 60 * 60 * 1000)
      });
      return false;
    }

    const pointsToAdd = Math.min(POINTS_CONFIG.DAILY_REGEN_AMOUNT, maxPoints - currentPoints);
    const newBalance = currentPoints + pointsToAdd;
    
    // Update user points
    await user.update({
      points: newBalance,
      points_next_regen: new Date(now.getTime() + 24 * 60 * 60 * 1000)
    });

    // Create transaction record
    await createTransaction(
      user.id,
      'regenerate',
      pointsToAdd,
      'Daily points regeneration',
      null
    );

    console.log(`Points regenerated for ${user.email}: +${pointsToAdd} (${currentPoints} → ${newBalance})`);
    
    // Notify user via socket if they're online
    notifyUserPointsUpdate(user.id, newBalance, `+${pointsToAdd} points regenerated!`);
    
    return true;
  } catch (error) {
    console.error('Error regenerating points for user:', user.email, error);
    return false;
  }
}

// Check all users for points regeneration
async function checkPointsRegeneration() {
  try {
    const now = new Date();
    const usersNeedingRegen = await User.findAll({
      where: {
        [Op.or]: [
          { points_next_regen: null },
          { points_next_regen: { [Op.lte]: now } }
        ],
        is_active: true
      }
    });

    console.log(`Checking points regeneration for ${usersNeedingRegen.length} users`);
    
    for (const user of usersNeedingRegen) {
      await regenerateUserPoints(user);
    }
  } catch (error) {
    console.error('Error in points regeneration check:', error);
  }
}

// Start the points regeneration system
function startPointsRegenerationSystem() {
  console.log('Starting points regeneration system...');
  
  // Run initial check
  checkPointsRegeneration();
  
  // Set up interval to check every minute
  setInterval(checkPointsRegeneration, POINTS_CONFIG.REGEN_CHECK_INTERVAL);
}

// Notify user of points update via socket
function notifyUserPointsUpdate(userId, newBalance, message) {
  // Find all sockets for this user
  const userSockets = authenticatedUsers.get(userId);
  if (userSockets && userSockets.size > 0) {
    userSockets.forEach(socketId => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('points_updated', {
          newBalance,
          message
        });
      }
    });
  }
}

// Spend points for a user
async function spendUserPoints(userId, amount, description, relatedId = null) {
  try {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new Error('User not found');
    }

    if (user.points < amount) {
      throw new Error('Insufficient points');
    }

    const newBalance = user.points - amount;
    
    // Update user points
    await user.update({ points: newBalance });

    // Create transaction record
    await createTransaction(userId, 'spend', amount, description, relatedId);

    console.log(`Points spent: ${user.email} spent ${amount} points. New balance: ${newBalance}`);
    
    // Notify user via socket
    notifyUserPointsUpdate(userId, newBalance, `Spent ${amount} points for ${description}`);
    
    return { success: true, newBalance };
  } catch (error) {
    console.error('Error spending points:', error);
    throw error;
  }
}

/*organize******************* */
//session management system

// Track active sessions by agent
const activeSessions = new Map(); // agentId -> { sessionId, userId, endTime }
const sessionQueues = new Map();  // agentId -> array of { userId, sessionId, queuePosition }

// Get active session for an agent
function getActiveSession(agentId) {
  return activeSessions.get(agentId) || null;
}

// Get queue for an agent
function getAgentQueue(agentId) {
  if (!sessionQueues.has(agentId)) {
    sessionQueues.set(agentId, []);
  }
  return sessionQueues.get(agentId);
}

// Add user to queue
async function addToQueue(agentId, userId, sessionId) {
  const queue = getAgentQueue(agentId);
  const queuePosition = queue.length + 1;
  
  queue.push({ userId, sessionId, queuePosition, addedAt: new Date() });
  
  // Update session in database
  await Session.update(
    { 
      status: 'queued', 
      queuePosition,
      estimatedWaitTime: queuePosition * 5 // 5 minutes per person ahead
    },
    { where: { id: sessionId } }
  );
  
  console.log(`User ${userId} added to queue for agent ${agentId}, position: ${queuePosition}`);
  return queuePosition;
}

// Start next session from queue
async function startNextSession(agentId) {
  const queue = getAgentQueue(agentId);
  if (queue.length === 0) return null;
  
  const nextInQueue = queue.shift();
  const { userId, sessionId } = nextInQueue;
  
  // Update queue positions for remaining users
  queue.forEach((item, index) => {
    item.queuePosition = index + 1;
  });
  
  // Update database for remaining queued sessions
  if (queue.length > 0) {
    const remainingSessionIds = queue.map(item => item.sessionId);
    await Session.update(
      { estimatedWaitTime: sequelize.literal('queue_position * 5') },
      { where: { id: { [Op.in]: remainingSessionIds } } }
    );
  }
  
  // Start the session
  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + PRIVATE_SESSION_DURATION_MINUTES * 60 * 1000);
  
  activeSessions.set(agentId, {
    sessionId,
    userId,
    agentId,
    startTime,
    endTime
  });
  
  // Update session in database
  await Session.update(
    {
      status: 'active',
      startTime,
      endTime,
      queuePosition: null,
      estimatedWaitTime: null
    },
    { where: { id: sessionId } }
  );
  
  console.log(`Session ${sessionId} started for user ${userId} with agent ${agentId}`);
  
  // Notify user that session started
  notifyUserSessionUpdate(userId, {
    type: 'session_started',
    sessionId,
    agentId,
    duration: 5,
    endTime: endTime.toISOString()
  });
  
  // Set timer for 1-minute warning (4 minutes after start)
  setTimeout(() => {
    notifyUserSessionUpdate(userId, {
      type: 'session_warning',
      sessionId,
      message: '⚠️ 1 minute remaining in your private session!'
    });
    
    // Notify next user in queue about upcoming session
    notifyNextUserInQueue(agentId);
  }, (PRIVATE_SESSION_DURATION_MINUTES - SESSION_WARNING_MINUTES) * 60 * 1000);
  
  // Set timer to end session
  setTimeout(() => endSession(sessionId), PRIVATE_SESSION_DURATION_MINUTES * 60 * 1000);
  
  return { sessionId, userId, startTime, endTime };
}

// End a session
async function endSession(sessionId) {
  try {
    const session = await Session.findByPk(sessionId);
    if (!session) return;
    
    const { agentId, userId } = session;
    
    // Remove from active sessions
    activeSessions.delete(agentId);
    
    // Update session in database
    await Session.update(
      { 
        status: 'completed',
        endTime: new Date()
      },
      { where: { id: sessionId } }
    );
    
    console.log(`Session ${sessionId} ended for user ${userId}`);
    
    // Notify user that session ended
    notifyUserSessionUpdate(userId, {
      type: 'session_ended',
      sessionId,
      message: 'Your private session has ended. Thank you!'
    });
    
    // Start next session in queue
    await startNextSession(agentId);
    
  } catch (error) {
    console.error('Error ending session:', error);
  }
}

// Notify user of session updates
function notifyUserSessionUpdate(userId, data) {
  const userSockets = authenticatedUsers.get(userId);
  if (userSockets && userSockets.size > 0) {
    userSockets.forEach(socketId => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit('session_update', data);
      }
    });
  }
}

// Notify next user in queue about upcoming session
function notifyNextUserInQueue(agentId) {
  const queue = getAgentQueue(agentId);
  if (queue.length > 0) {
    const nextUser = queue[0];
    notifyUserSessionUpdate(nextUser.userId, {
      type: 'queue_warning',
      message: '🔔 You\'re next! Your session will start in about 1 minute.'
    });
  }
}

// Clean up expired sessions on startup
async function cleanupExpiredSessions() {
  try {
    const now = new Date();
    const expiredSessions = await Session.findAll({
      where: {
        status: 'active',
        endTime: { [Op.lt]: now }
      }
    });
    
    for (const session of expiredSessions) {
      await endSession(session.id);
    }
    
    console.log(`Cleaned up ${expiredSessions.length} expired sessions`);
  } catch (error) {
    console.error('Error cleaning up expired sessions:', error);
  }
}

/*organize******************* */
//something related to agent works

// Add periodic ping to keep counts accurate
setInterval(() => {
  for (const [agentId, viewers] of agentViewers.entries()) {
    io.emit(`${agentId}_viewer_count`, { count: viewers.size });
  }
}, 5000); // Update every 5 seconds

// Get count of authenticated users (not just socket connections)
function getAuthenticatedUserCount() {
  return authenticatedUsers.size;
}

// Get total socket connections (for debugging)
function getTotalConnections() {
  return io.engine.clientsCount;
}

/*organize*************** */
//sockets
//emit

// Update the socket connection handler
io.on('connection', (socket) => {
  const userInfo = socket.user ? `${socket.user.email} (${socket.user.id})` : 'anonymous';
  console.log(`Client connected: ${socket.id} - User: ${userInfo}`);

  // Track authenticated users
  if (socket.user && socket.user.isAuthenticated) {
    const userId = socket.user.id;
    if (!authenticatedUsers.has(userId)) {
      authenticatedUsers.set(userId, new Set());
    }
    authenticatedUsers.get(userId).add(socket.id);
    console.log(`Authenticated user count: ${getAuthenticatedUserCount()}`);
  }

  // Send initial state with user authentication status
  socket.emit('initial_state', {
    peerCount: getAuthenticatedUserCount(), // Use authenticated user count
    commentCount,
    authenticated: socket.user?.isAuthenticated || false,
    user: socket.user ? { id: socket.user.id, email: socket.user.email } : null
  });

  // Emit authenticated user count to all clients
  io.emit('peer_count', { count: getAuthenticatedUserCount() });

  socket.on('request_peer_count', () => {
    socket.emit('peer_count', { count: getAuthenticatedUserCount() });
  });

  socket.on('new_comment', async (data) => {
    console.log('new_comment event received:', { socketId: socket.id, data });
    
    const { comment, agentId } = data;
    
    // Check authentication for commenting (allows free access to Trump model)
    if (!requireAuthForComment(socket, agentId, (error) => {
      socket.emit('comment_error', error);
    })) {
      return;
    }
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
      
      // Handle both authenticated and anonymous users (for free model)
      const isAuthenticated = socket.user && socket.user.isAuthenticated;
      const userId = isAuthenticated ? socket.user.id : `anonymous_${Date.now()}`;
      const userEmail = isAuthenticated ? socket.user.email : 'anonymous';
      const userHandle = comment.handle || (isAuthenticated ? socket.user.email.split('@')[0] : 'Anonymous');
      
      const newComment = await Comment.create({
        id: messageId,
        message: filteredMessage,
        agentId,
        user: userEmail,
        avatar: comment.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${userId}`,
        handle: userHandle,
        userId: userId
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

    // Log user joining stream
    const userIdentifier = socket.user ? socket.user.email : 'anonymous';
    console.log(`User ${userIdentifier} joined agent ${agentId} stream`);

    emitStreamCounts(); // Emit updated counts to all clients
    
    // Confirm successful join
    socket.emit('stream_joined', { 
      agentId, 
      authenticated: socket.user ? socket.user.isAuthenticated : false 
    });
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
    // Clean up agent streams
    const agentId = socketToStream.get(socket.id);
    if (agentId) {
      agentViewers.get(agentId)?.delete(socket.id);
      socketToStream.delete(socket.id);
      emitStreamCounts(); // Emit updated counts to all clients
    }
    
    // Clean up authenticated users tracking
    if (socket.user && socket.user.isAuthenticated) {
      const userId = socket.user.id;
      const userSockets = authenticatedUsers.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        // If user has no more socket connections, remove them completely
        if (userSockets.size === 0) {
          authenticatedUsers.delete(userId);
        }
      }
      console.log(`Authenticated user count after disconnect: ${getAuthenticatedUserCount()}`);
    }
    
    const userInfo = socket.user ? `${socket.user.email} (${socket.user.id})` : 'anonymous';
    console.log(`Client disconnected: ${socket.id} - User: ${userInfo}`);
    
    // Emit updated authenticated user count to all remaining clients
    io.emit('peer_count', { count: getAuthenticatedUserCount() });
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

    const { amount, reason, relatedId } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid amount'
      });
    }

    // Use the new points spending system
    const result = await spendUserPoints(
      decoded.userId, 
      amount, 
      reason || 'Points spent',
      relatedId
    );

    res.json({
      success: true,
      newBalance: result.newBalance,
      transaction: {
        amount,
        reason: reason || 'Points spent',
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Spend points error:', error);
    
    if (error.message === 'User not found') {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    
    if (error.message === 'Insufficient points') {
      return res.status(400).json({
        success: false,
        error: 'Insufficient points'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Get user points history
app.get('/api/users/points-history', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired access token'
      });
    }

    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;

    const transactions = await Transaction.findAll({
      where: { userId: decoded.userId },
      order: [['createdAt', 'DESC']],
      limit,
      offset
    });

    const totalCount = await Transaction.count({
      where: { userId: decoded.userId }
    });

    res.json({
      success: true,
      transactions: transactions.map(t => t.toJSON()),
      pagination: {
        total: totalCount,
        limit,
        offset,
        hasMore: offset + limit < totalCount
      }
    });

  } catch (error) {
    console.error('Points history error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Book private session with points
app.post('/api/sessions/book-private', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired access token'
      });
    }

    const { agentId, duration = 5 } = req.body;
    const cost = POINTS_CONFIG.PRIVATE_SESSION_COST;
    const userId = decoded.userId;

    if (!agentId) {
      return res.status(400).json({
        success: false,
        error: 'Agent ID is required'
      });
    }

    // Check if user already has an active session
    const existingSession = await Session.findOne({
      where: {
        userId,
        status: { [Op.in]: ['active', 'queued'] }
      }
    });

    if (existingSession) {
      return res.status(400).json({
        success: false,
        error: 'You already have an active or queued session'
      });
    }

    // Create session ID
    const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);

    // Spend points for the session
    const result = await spendUserPoints(
      userId,
      cost,
      `Private session with agent ${agentId}`,
      sessionId
    );

    // Create session record in database
    const sessionData = await Session.create({
      id: sessionId,
      userId,
      agentId,
      duration,
      pointsCost: cost,
      status: 'queued'
    });

    // Check if agent is available or add to queue
    const activeSession = getActiveSession(agentId);
    
    if (!activeSession) {
      // Agent is available, start session immediately
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + PRIVATE_SESSION_DURATION_MINUTES * 60 * 1000);
      
      activeSessions.set(agentId, {
        sessionId,
        userId,
        agentId,
        startTime,
        endTime
      });
      
      // Update session in database
      await Session.update(
        {
          status: 'active',
          startTime,
          endTime,
          queuePosition: null,
          estimatedWaitTime: null
        },
        { where: { id: sessionId } }
      );
      
      console.log(`Session ${sessionId} started immediately for user ${userId} with agent ${agentId}`);
      
      // Notify user that session started
      notifyUserSessionUpdate(userId, {
        type: 'session_started',
        sessionId,
        agentId,
        duration: 5,
        endTime: endTime.toISOString()
      });
      
      // Set timer for 1-minute warning (4 minutes after start)
      setTimeout(() => {
        notifyUserSessionUpdate(userId, {
          type: 'session_warning',
          sessionId,
          message: '⚠️ 1 minute remaining in your private session!'
        });
        
        // Notify next user in queue about upcoming session
        notifyNextUserInQueue(agentId);
      }, (PRIVATE_SESSION_DURATION_MINUTES - SESSION_WARNING_MINUTES) * 60 * 1000);
      
      // Set timer to end session
      setTimeout(() => endSession(sessionId), PRIVATE_SESSION_DURATION_MINUTES * 60 * 1000);
      
      res.json({
        success: true,
        session: {
          id: sessionId,
          status: 'active',
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          message: 'Session started immediately!'
        },
        newBalance: result.newBalance
      });
    } else {
      // Agent is busy, add to queue
      const queuePosition = await addToQueue(agentId, userId, sessionId);
      const estimatedWait = queuePosition * 5; // 5 minutes per person
      
      res.json({
        success: true,
        session: {
          id: sessionId,
          status: 'queued',
          queuePosition,
          estimatedWaitMinutes: estimatedWait,
          message: `You're #${queuePosition} in queue. Estimated wait: ${estimatedWait} minutes`
        },
        newBalance: result.newBalance
      });
    }

  } catch (error) {
    console.error('Book private session error:', error);
    
    if (error.message === 'Insufficient points') {
      return res.status(400).json({
        success: false,
        error: `Insufficient points. You need ${POINTS_CONFIG.PRIVATE_SESSION_COST} points for a private session.`
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Get current session status for user
app.get('/api/sessions/current', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired access token'
      });
    }

    const session = await Session.findOne({
      where: {
        userId: decoded.userId,
        status: { [Op.in]: ['active', 'queued'] }
      },
      order: [['createdAt', 'DESC']]
    });

    if (!session) {
      return res.json({
        success: true,
        session: null
      });
    }

    // Calculate remaining time for active sessions
    let remainingTime = null;
    if (session.status === 'active' && session.endTime) {
      const now = new Date();
      const endTime = new Date(session.endTime);
      remainingTime = Math.max(0, Math.floor((endTime - now) / 1000)); // seconds
    }

    res.json({
      success: true,
      session: {
        id: session.id,
        agentId: session.agentId,
        status: session.status,
        queuePosition: session.queuePosition,
        estimatedWaitMinutes: session.estimatedWaitTime,
        remainingTimeSeconds: remainingTime,
        startTime: session.startTime,
        endTime: session.endTime
      }
    });

  } catch (error) {
    console.error('Get current session error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Cancel a queued session
app.post('/api/sessions/cancel', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired access token'
      });
    }

    const { sessionId } = req.body;
    const userId = decoded.userId;

    const session = await Session.findOne({
      where: {
        id: sessionId,
        userId,
        status: 'queued'
      }
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found or cannot be cancelled'
      });
    }

    // Remove from queue
    const queue = getAgentQueue(session.agentId);
    const queueIndex = queue.findIndex(item => item.sessionId === sessionId);
    if (queueIndex !== -1) {
      queue.splice(queueIndex, 1);
      
      // Update positions for remaining users
      queue.forEach((item, index) => {
        item.queuePosition = index + 1;
      });
    }

    // Update session status
    await Session.update(
      { status: 'cancelled' },
      { where: { id: sessionId } }
    );

    // Refund points
    await createTransaction(
      userId,
      'earn',
      session.pointsCost,
      'Session cancellation refund',
      sessionId
    );

    const user = await User.findByPk(userId);
    await user.update({ points: user.points + session.pointsCost });

    res.json({
      success: true,
      message: 'Session cancelled and points refunded',
      refundedPoints: session.pointsCost
    });

  } catch (error) {
    console.error('Cancel session error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Get agent availability status
app.get('/api/agents/availability', async (req, res) => {
  try {
    const agents = ['agent-1', 'agent-2', 'agent-3']; // Your agent IDs
    const availability = {};
    
    for (const agentId of agents) {
      const activeSession = getActiveSession(agentId);
      const queue = getAgentQueue(agentId);
      
      // Calculate remaining time for active session
      let remainingTime = null;
      let currentUser = null;
      
      if (activeSession) {
        const now = new Date();
        const endTime = new Date(activeSession.endTime);
        remainingTime = Math.max(0, Math.floor((endTime - now) / 1000)); // seconds
        
        // Get user info for current session
        try {
          const user = await User.findByPk(activeSession.userId);
          currentUser = user ? {
            name: user.name,
            email: user.email.split('@')[0], // Hide domain for privacy
            startTime: activeSession.startTime,
            endTime: activeSession.endTime,
            remainingSeconds: remainingTime
          } : null;
        } catch (error) {
          console.error('Error fetching current user:', error);
        }
      }
      
      // Get queue details with user information
      const queueDetails = [];
      for (let i = 0; i < queue.length; i++) {
        const queueItem = queue[i];
        try {
          const user = await User.findByPk(queueItem.userId);
          queueDetails.push({
            position: i + 1,
            userId: queueItem.userId,
            userName: user ? user.name : 'Unknown User',
            userEmail: user ? user.email.split('@')[0] : 'unknown', // Hide domain
            addedAt: queueItem.addedAt,
            estimatedStartTime: new Date(Date.now() + (remainingTime * 1000) + (i * 5 * 60 * 1000))
          });
        } catch (error) {
          console.error('Error fetching queue user:', error);
          queueDetails.push({
            position: i + 1,
            userId: queueItem.userId,
            userName: 'Unknown User',
            userEmail: 'unknown',
            addedAt: queueItem.addedAt,
            estimatedStartTime: new Date(Date.now() + (remainingTime * 1000) + (i * 5 * 60 * 1000))
          });
        }
      }
      
      availability[agentId] = {
        isAvailable: !activeSession,
        queueLength: queue.length,
        estimatedWaitTime: queue.length * 5, // 5 minutes per person in queue
        currentSession: currentUser,
        remainingTimeSeconds: remainingTime,
        queueDetails: queueDetails
      };
    }
    
    res.json({
      success: true,
      agents: availability
    });
  } catch (error) {
    console.error('Get agent availability error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Get user points info with next regeneration time
app.get('/api/users/points-info', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired access token'
      });
    }

    const user = await User.findByPk(decoded.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const now = new Date();
    const nextRegen = user.points_next_regen;
    const timeUntilRegen = nextRegen ? Math.max(0, nextRegen.getTime() - now.getTime()) : 0;

    res.json({
      success: true,
      points: user.points,
      maxPoints: POINTS_CONFIG.MAX_POINTS,
      dailyRegenAmount: POINTS_CONFIG.DAILY_REGEN_AMOUNT,
      nextRegeneration: nextRegen,
      timeUntilRegenMs: timeUntilRegen,
      canRegenerate: timeUntilRegen === 0 && user.points < POINTS_CONFIG.MAX_POINTS
    });

  } catch (error) {
    console.error('Points info error:', error);
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
app.get('/api/agents/:agentId/chat-history', optionalAuth, async (req, res) => {
  try {
    const { agentId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before ? new Date(req.query.before) : new Date();

    // Build where clause based on model type
    const whereClause = {
      agentId,
      createdAt: { [Op.lt]: before }
    };
    
    console.log('Chat history request:', {
      agentId,
      isFreeModel: agentId === FREE_MODEL_AGENT_ID,
      userAuthenticated: !!req.user,
      userEmail: req.user?.email
    });
    
    // For private models, filter by authenticated user
    if (agentId !== FREE_MODEL_AGENT_ID && req.user) {
      // Filter by user email only (messageType column doesn't exist yet)
      whereClause.user = req.user.email;
      console.log('Filtering by user email:', req.user.email);
    } else if (agentId !== FREE_MODEL_AGENT_ID && !req.user) {
      // If accessing private model without auth, return empty
      console.log('Private model accessed without authentication');
      return res.json({ chatHistory: [] });
    }
    
    // Fetch comments and AI responses in parallel
    const [comments] = await Promise.all([
      Comment.findAll({
        where: whereClause,
        order: [['createdAt', 'DESC']],
        limit,
        raw: true
      })
    ]);
    
    console.log('Found comments:', comments.length);
    if (comments.length > 0) {
      console.log('First comment user:', comments[0].user);
    }

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