# Borp Server

A real-time streaming backend service built with Node.js, Express, Socket.IO, and SQLITE.

## Table of Contents
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Server](#running-the-server)
- [Architecture Overview](#architecture-overview)
- [API Documentation](#api-documentation)
- [📚 Additional Resources](#additional-resources)

## Prerequisites

Before you begin, ensure you have the following installed:
- Node.js (v18 or later)
- SQLITE (local or Atlas account)
- Bun (for package management and running)
- Git

## Installation

1. Clone the repository:
```bash
git clone https://github.com/Bor-Protocol/Bor-Server.git
```

2. Install dependencies:
```bash
bun install
```

3. Create environment file:
```bash
cp copy.env .env
```

## Configuration

1. Configure your `.env` file with the following variables:
```env
PORT=6969
BUNNY_STORAGE_API_KEY=your_bunny_cdn_key
```


## Running the Server

1. Start SQLITE (if using local instance)


2. Run the server in development mode:
```bash
node --inspect src/index.js  
```


4. Using Docker:
```bash
docker build -t borp-server .
docker run -p 6969:6969 -p 8080:8080 borp-server
```

## Architecture Overview

### Core Technologies
- **Runtime**: Node.js with Bun
- **Server**: Express.js
- **Real-time Communication**: Socket.IO
- **Database**: SQLITE
- **File Storage**: BunnyCDN

### Key Features

#### 1. Real-time Communication
- WebSocket implementation using Socket.IO
- Event-based architecture for:
  - Stream status updates
  - Chat messages
  - Audio responses

#### 2. Data Management
- SQLITE schemas for:
  - Comments


#### 3. File Handling
- Audio file upload system
- BunnyCDN integration for file storage
- Streaming media support

## API Documentation

### WebSocket Events

#### Client Events
```javascript
socket.emit('join_agent_stream', agentId)
socket.emit('leave_agent_stream', agentId)
socket.emit('new_comment', commentData)
```

#### Server Events
```javascript
socket.on('streaming_status_update', statusData)
socket.on('comment_received', commentData)
socket.on('audio_response', audioData)
```

### REST Endpoints

#### Stream Management
```
GET    /api/scenes                # Get all active streams
POST   /api/scenes                # Create new stream
PUT    /api/scenes/:agentId       # Update stream config
```

#### User Interactions
```
GET    /api/streams/:agentId/stats    # Get stream statistics
POST   /api/comments/mark-read        # Mark comments as read
```

#### Audio Management
```
POST   /api/upload/audio              # Upload audio file
```

## Error Handling

The server implements comprehensive error handling:
- Socket connection errors
- Database operation failures
- File upload issues
- API request validation

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.


to launch in debug mode : node --inspect src/index.js    

## 📚 Additional Resources

- [Socket.IO Documentation](https://socket.io/docs/)
- [Express.js Guide](https://expressjs.com/guide)
- [SQLite Documentation](https://sqlite.org/docs.html)
- [BunnyCDN Documentation](https://docs.bunny.net/)