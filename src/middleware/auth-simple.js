// Real JWT authentication middleware
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const FREE_MODEL_AGENT_ID = process.env.FREE_MODEL_AGENT_ID || '795df77f-1620-07db-bd9a-0e2dfefef248';

// Real JWT token verification
export const verifyToken = (token) => {
  try {
    if (!token) return null;
    
    // Verify JWT token
    const decoded = jwt.verify(token, JWT_SECRET);
    return {
      userId: decoded.userId,
      email: decoded.email,
      userType: decoded.userType,
      isAuthenticated: true
    };
  } catch (error) {
    console.error('Token verification error:', error.message);
    return null;
  }
};

// Socket.io authentication middleware
export const socketAuthMiddleware = (socket, next) => {
  try {
    // Extract token from handshake auth or query
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    
    if (!token) {
      // Allow anonymous connections for public features
      socket.user = null;
      return next();
    }

    // Verify token (simplified)
    const decoded = verifyToken(token);
    if (!decoded) {
      return next(new Error('Invalid authentication token'));
    }

    // Attach user info to socket
    socket.user = {
      id: decoded.userId,
      email: decoded.email,
      isAuthenticated: true
    };

    console.log(`User authenticated: ${decoded.email} (${decoded.userId})`);
    next();
  } catch (error) {
    console.error('Socket authentication error:', error);
    next(new Error('Authentication failed'));
  }
};

// Express middleware for API authentication
export const authenticateApiToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: 'Access token required' 
    });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(403).json({ 
      success: false, 
      error: 'Invalid or expired token' 
    });
  }

  req.user = {
    id: decoded.userId,
    email: decoded.email
  };

  next();
};

// Optional authentication middleware
export const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    const decoded = verifyToken(token);
    if (decoded) {
      req.user = {
        id: decoded.userId,
        email: decoded.email
      };
    }
  }

  next();
};

// Express middleware for authentication
export const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Access token required'
    });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired access token'
    });
  }

  // Attach user info to request
  req.user = {
    id: decoded.userId,
    email: decoded.email,
    userType: decoded.userType
  };

  next();
};

// Check if user is authenticated for socket events
export const requireSocketAuth = (socket, callback) => {
  if (!socket.user || !socket.user.isAuthenticated) {
    return callback({
      success: false,
      error: 'Authentication required for this action'
    });
  }
  return true;
};

// Check if user is authenticated for commenting (allows free access to Trump model)
export const requireAuthForComment = (socket, agentId, callback) => {
  // Allow free access to Trump model
  if (agentId === FREE_MODEL_AGENT_ID) {
    return true;
  }
  
  // Require authentication for other models
  if (!socket.user || !socket.user.isAuthenticated) {
    return callback({
      success: false,
      error: 'Authentication required to comment on this model'
    });
  }
  return true;
};

// Check user permissions for agent-specific actions
export const checkAgentPermissions = (socket, agentId, callback) => {
  // Allow free access to Trump model
  if (agentId === FREE_MODEL_AGENT_ID) {
    return true;
  }
  
  // Require authentication for other models
  if (!socket.user || !socket.user.isAuthenticated) {
    return callback({
      success: false,
      error: 'Authentication required to interact with this agent'
    });
  }
  return true;
};