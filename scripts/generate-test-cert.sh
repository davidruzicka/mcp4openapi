#!/bin/bash
# Generate self-signed SSL certificate for local development
# This script creates a certificate valid for localhost and common local IPs

set -e

CERT_DIR="./ssl-certs"
CERT_FILE="${CERT_DIR}/cert.pem"
KEY_FILE="${CERT_DIR}/key.pem"
DAYS=365

echo "🔐 Generating self-signed SSL certificate for development..."

# Create directory if it doesn't exist
mkdir -p "${CERT_DIR}"

# Generate private key and certificate
openssl req -x509 \
  -newkey rsa:4096 \
  -keyout "${KEY_FILE}" \
  -out "${CERT_FILE}" \
  -days ${DAYS} \
  -nodes \
  -subj "/CN=localhost/O=MCP4OpenAPI Dev/C=US" \
  -addext "subjectAltName=DNS:localhost,DNS:*.local,DNS:*.localhost,IP:127.0.0.1,IP:10.0.118.42"

echo "✅ Certificate generated successfully!"
echo ""
echo "📁 Files created:"
echo "   Certificate: ${CERT_FILE}"
echo "   Private Key: ${KEY_FILE}"
echo ""
echo "🔧 To use these certificates, set environment variables:"
echo ""
echo "   export MCP4_SSL_CERT_FILE=$(pwd)/${CERT_FILE}"
echo "   export MCP4_SSL_KEY_FILE=$(pwd)/${KEY_FILE}"
echo "   export MCP4_OAUTH_REDIRECT_URI=https://localhost:3003/oauth/callback"
echo ""
echo "🚀 Then start the server:"
echo ""
echo "   npm start"
echo ""
echo "⚠️  Note: Self-signed certificates will trigger browser warnings."
echo "   See SSL_SETUP.md for instructions on adding to system trust store."



