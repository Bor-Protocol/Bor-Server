import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { Op } from 'sequelize';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Filter } from 'bad-words';
import * as badwordsList from 'badwords-list';
import { uploadAudioToBunnyCDN } from './upload/uploadCdn.js';
import { initDatabase } from './config/database.js';

// Import models
import Comment from '../models/Comment.js';

// Initialize environment variables
dotenv.config();

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

// Configure Socket.IO with CORS
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["*"],
    credentials: true
  }
});

// Initialize counters
let commentCount = 0;

// Initialize database
initDatabase()
  .then(async () => {
    console.log('Connected to SQLite successfully');
    try {
      commentCount = await Comment.count();
      console.log('Initial counts loaded - Comments:', commentCount);
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
  console.log('Client connected:', socket.id);

  socket.emit('initial_state', {
    peerCount: getConnectedPeers(),
    commentCount
  });

  io.emit('peer_count', { count: getConnectedPeers() });

  socket.on('request_peer_count', () => {
    socket.emit('peer_count', { count: getConnectedPeers() });
  });

  socket.on('new_comment', async (data) => {
    console.log('new_comment event received:', { socketId: socket.id, data });
    
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
      
      const newComment = await Comment.create({
        id: messageId,
        message: filteredMessage,
        agentId,
        user: comment.user,
        avatar: comment.avatar,
        handle: comment.handle
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
    }
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });

  // Add these new socket event handlers
  socket.on('join_agent_stream', (agentId) => {
    const previousStream = socketToStream.get(socket.id);
    if (previousStream) {
      agentViewers.get(previousStream)?.delete(socket.id);
    }

    socketToStream.set(socket.id, agentId);
    if (!agentViewers.has(agentId)) {
      agentViewers.set(agentId, new Set());
    }
    agentViewers.get(agentId)?.add(socket.id);

    emitStreamCounts(); // Emit updated counts to all clients
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
  });

  // Update the disconnect handler
  socket.on('disconnect', () => {
    const agentId = socketToStream.get(socket.id);
    if (agentId) {
      agentViewers.get(agentId)?.delete(socket.id);
      socketToStream.delete(socket.id);
      emitStreamCounts(); // Emit updated counts to all clients
    }
    console.log('Client disconnected:', socket.id);
  });
});

/******************** */

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
        const userProfile = await UserProfile.findOne({ publicKey: requestBody.replyToUser });
        handle = userProfile?.handle;
        pfp = userProfile?.pfp;
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
app.post('/api/comments/mark-read', async (req, res) => {
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
      modifiedCount: result.modifiedCount
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