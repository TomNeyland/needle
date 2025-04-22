#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Define paths
const gitHooksDir = path.join(__dirname, '..', '.git', 'hooks');
const prePushSource = path.join(__dirname, 'pre-push');
const prePushTarget = path.join(gitHooksDir, 'pre-push');

// Create the pre-push hook content - properly escape $ for shell variables
const prePushContent = `#!/bin/bash

# Get the current version from package.json
CURRENT_VERSION=\$(node -p "require('./package.json').version")

# Split the version into major.minor.patch
IFS='.' read -r -a VERSION_PARTS <<< "\$CURRENT_VERSION"
MAJOR="\${VERSION_PARTS[0]}"
MINOR="\${VERSION_PARTS[1]}"
PATCH="\${VERSION_PARTS[2]}"

# Increment the patch version
NEW_PATCH=\$((PATCH + 1))
NEW_VERSION="\${MAJOR}.\${MINOR}.\${NEW_PATCH}"

# Update package.json with the new version
# We use a temporary file to avoid issues with the update
node -e "
const fs = require('fs');
const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
packageJson.version = '\${NEW_VERSION}';
fs.writeFileSync('./package.json', JSON.stringify(packageJson, null, 2) + '\\n');
"

# Stage and commit the updated package.json
git add package.json
git commit -m "Bump version to \${NEW_VERSION}" --no-verify

echo "Bumped version from \$CURRENT_VERSION to \$NEW_VERSION"
`;

// Create hooks directory if it doesn't exist
if (!fs.existsSync(gitHooksDir)) {
  console.log('Creating .git/hooks directory...');
  fs.mkdirSync(gitHooksDir, { recursive: true });
}

// First create the pre-push hook file in scripts folder
fs.writeFileSync(prePushSource, prePushContent);
console.log(`Created pre-push hook script at ${prePushSource}`);

// Copy to git hooks directory
fs.copyFileSync(prePushSource, prePushTarget);
console.log(`Installed pre-push hook to ${prePushTarget}`);

// Make the hook executable
try {
  execSync(`chmod +x ${prePushTarget}`);
  console.log('Made pre-push hook executable');
} catch (error) {
  console.error('Failed to make pre-push hook executable:', error);
  console.log('Please run: chmod +x .git/hooks/pre-push');
}

console.log('Git pre-push hook installation complete!');
