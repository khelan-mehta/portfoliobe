import mongoose from 'mongoose';

const keyStoreSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now }
});

export const KeyStore = mongoose.model('KeyStore', keyStoreSchema);

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('MONGODB_URI not found, falling back to local storage');
    return false;
  }
  try {
    await mongoose.connect(uri);
    console.log('MongoDB connected successfully');
    return true;
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    return false;
  }
}
