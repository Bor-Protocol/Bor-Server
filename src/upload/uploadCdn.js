import * as https from 'https';

const BUNNY_STORAGE_HOST = process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';
const BUNNY_STORAGE_PATH = process.env.BUNNY_STORAGE_PATH || '/borstorage1/speech';
const BUNNY_CDN_URL = process.env.BUNNY_CDN_URL || 'https://borstorage1.b-cdn.net/speech';

export const uploadAudioToBunnyCDN = async (audioBuffer) => {
  const timestamp = Date.now();
  const fileName = `${timestamp}.mp3`;

  try {
    const options = {
      method: 'PUT',
      host: BUNNY_STORAGE_HOST,
      path: `${BUNNY_STORAGE_PATH}/${fileName}`,
      headers: {
        'AccessKey': process.env.BUNNY_STORAGE_API_KEY || '',
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length,
      },
    };
    // Log API key length and first few characters for debugging (never log full API key)
    const apiKey = process.env.BUNNY_STORAGE_API_KEY || '';
    console.log("BunnyCDN Upload Debug:", {
      apiKeyLength: apiKey.length,
      apiKeyPrefix: apiKey.substring(0, 8) + '...',
      host: BUNNY_STORAGE_HOST,
      path: `${BUNNY_STORAGE_PATH}/${fileName}`,
      publicUrl: `${BUNNY_CDN_URL}/${fileName}`
    });
    const publicUrl = await new Promise((resolve, reject) => {
      const uploadReq = https.request(options, (uploadRes) => {
        const isSuccess = [200, 201].includes(uploadRes.statusCode || 0);
        if (isSuccess) {
          const publicUrl = `${BUNNY_CDN_URL}/${fileName}`;
          console.log("BunnyCDN upload successful", { publicUrl });
          resolve(publicUrl);
        } else {
          console.log("BunnyCDN upload failed:", {
            statusCode: uploadRes.statusCode,
            statusMessage: uploadRes.statusMessage,
            headers: uploadRes.headers
          });
          
          let errorData = '';
          uploadRes.on('data', chunk => errorData += chunk);
          uploadRes.on('end', () => {
            console.log("BunnyCDN error response:", errorData);
            reject(new Error(`Upload failed with status ${uploadRes.statusCode}: ${errorData}`));
          });
        }
      });

      uploadReq.on('error', (error) => reject(error));

      uploadReq.write(audioBuffer);
      uploadReq.end();
    });

    return publicUrl;
  } catch (error) {
    throw new Error("Audio upload failed");
  }
};

