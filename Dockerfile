FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all files except .env (Railway provides env vars)
COPY . .

# Expose port
EXPOSE 6969

# Start the server
CMD ["npm", "start"]