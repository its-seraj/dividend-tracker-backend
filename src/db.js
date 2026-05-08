const mongoose = require('mongoose');

async function connectDb(uri) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  return mongoose.connection;
}

module.exports = { connectDb };
