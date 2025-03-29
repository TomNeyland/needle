
const fs = require('fs');
const path = require('path');

// Get the extension's root directory
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const mainFile = path.join(distDir, 'extension.js');

console.log('Checking build status:');
console.log('---------------------');

// Check if dist directory exists
if (!fs.existsSync(distDir)) {
  console.log('❌ Dist directory does not exist!');
  process.exit(1);
} else {
  console.log('✅ Dist directory exists');
}

// Check if the main extension file exists
if (!fs.existsSync(mainFile)) {
  console.log('❌ Main extension file (extension.js) not found!');
  process.exit(1);
} else {
  const stats = fs.statSync(mainFile);
  const lastModified = new Date(stats.mtime);
  console.log(`✅ Main extension file exists (last modified: ${lastModified.toLocaleString()})`);
}

// Check package.json main field
const packageJson = require(path.join(rootDir, 'package.json'));
console.log(`📄 Package.json main field points to: ${packageJson.main}`);

console.log('---------------------');
console.log('✅ Build check complete');