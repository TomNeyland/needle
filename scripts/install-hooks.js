#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Define paths
const gitHooksDir = path.join(__dirname, '..', '.git', 'hooks');
const preCommitSource = path.join(__dirname, 'pre-commit');
const preCommitTarget = path.join(gitHooksDir, 'pre-commit');

// Create the pre-commit hook content - properly escape $ for shell variables
const preCommitContent = `#!/bin/bash

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

# Stage the updated package.json
git add package.json

echo "Bumped version from \$CURRENT_VERSION to \$NEW_VERSION"
`;

// Create hooks directory if it doesn't exist
if (!fs.existsSync(gitHooksDir)) {
  console.log('Creating .git/hooks directory...');
  fs.mkdirSync(gitHooksDir, { recursive: true });
}

// First create the pre-commit hook file in scripts folder
fs.writeFileSync(preCommitSource, preCommitContent);
console.log(`Created pre-commit hook script at ${preCommitSource}`);

// Copy to git hooks directory
fs.copyFileSync(preCommitSource, preCommitTarget);
console.log(`Installed pre-commit hook to ${preCommitTarget}`);

// Make the hook executable
try {
  execSync(`chmod +x ${preCommitTarget}`);
  console.log('Made pre-commit hook executable');
} catch (error) {
  console.error('Failed to make pre-commit hook executable:', error);
  console.log('Please run: chmod +x .git/hooks/pre-commit');
}

console.log('Git pre-commit hook installation complete!');
