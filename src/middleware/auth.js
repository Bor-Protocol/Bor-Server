import jwt from 'jsonwebtoken';

// JWT Configuration - should match the Protocol auth system
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';

export const verifyToken = (token) => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return { userId: decoded.userId, email: decoded.email };
  } catch (error) {
    console.error('JWT verification error:', error.message);
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

    // Verify JWT token
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

// Optional authentication middleware (allows both authenticated and anonymous users)
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

// Check if user is authenticated for socket events
export const requireAuth = (socket, callback) => {
  if (!socket.user || !socket.user.isAuthenticated) {
    return callback({
      success: false,
      error: 'Authentication required for this action'
    });
  }
  return true;
};

// Check user permissions for agent-specific actions
export const checkAgentPermissions = (socket, agentId, callback) => {
  // For now, all authenticated users can interact with any agent
  // This can be extended with role-based permissions later
  if (!socket.user || !socket.user.isAuthenticated) {
    return callback({
      success: false,
      error: 'Authentication required to interact with agents'
    });
  }
  return true;
};