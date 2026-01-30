# SAP Basis Jahresplaner - Client/Server Deployment Guide

## Overview

This guide explains how to deploy the SAP Basis Jahresplaner in a client/server architecture, allowing multiple users to access the same database from different computers.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Client 1      │     │   Client 2      │     │   Client 3      │
│ (Browser/HTML)  │     │ (Browser/HTML)  │     │ (Browser/HTML)  │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │      Network/LAN        │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │     Server Machine      │
                    │  ┌──────────────────┐   │
                    │  │   Node.js API    │   │
                    │  │   (server.js)    │   │
                    │  │   Port: 3232     │   │
                    │  └────────┬─────────┘   │
                    │           │             │
                    │  ┌────────▼─────────┐   │
                    │  │   SQLite DB      │   │
                    │  │ (sap-planner.db) │   │
                    │  └──────────────────┘   │
                    └─────────────────────────┘
```

---

## Part 1: Server Setup

### Prerequisites

- **Operating System:** Windows Server, Linux, or macOS
- **Node.js:** Version 24 or higher (LTS)
- **Network:** Server must be accessible from client machines (check firewall)

### Step 1: Prepare Server Directory

```bash
# Create a directory on the server
mkdir /opt/sap-basis-planner
cd /opt/sap-basis-planner

# Copy these files from your development machine:
# - server.js
# - package.json
# - sap-planner.html (optional - for web serving)
```

### Step 2: Install Dependencies

```bash
cd /opt/sap-basis-planner
npm install
```

### Step 3: Configure Server (Optional)

Edit `server.js` to customize settings:

```javascript
// Line ~940: Change port if needed
const PORT = process.env.PORT || 3232;

// Line ~125: Change default admin password (IMPORTANT!)
const passwordHash = bcrypt.hashSync('YOUR_NEW_PASSWORD', 10);
```

### Step 4: Start the Server

**For testing:**
```bash
npm start
```

**For production (keeps running after logout):**
```bash
# Install PM2 process manager
npm install -g pm2

# Start with PM2
pm2 start server.js --name "sap-planner"

# Auto-restart on server reboot
pm2 startup
pm2 save
```

### Step 5: Verify Server is Running

From the server itself:
```bash
curl http://localhost:3232/api/settings
```

From another machine:
```bash
curl http://SERVER_IP:3232/api/settings
```

---

## Part 2: Client Configuration

### Step 1: Modify the Frontend

Edit `sap-planner.html` and find this line (around line 86):

```javascript
// BEFORE (local development):
this.baseUrl = 'http://localhost:3232';

// AFTER (production):
this.baseUrl = 'http://YOUR_SERVER_IP:3232';
// Example:
this.baseUrl = 'http://192.168.1.100:3232';
// Or with hostname:
this.baseUrl = 'http://sap-planner.yourcompany.local:3232';
```

### Step 2: Distribute to Users

**Option A: Share the HTML file**
- Send the modified `sap-planner.html` to colleagues via email or file share
- Users open the file directly in their browser (Chrome, Firefox, Edge)

**Option B: Serve from the server**
- Place `sap-planner.html` in the server directory
- Users navigate to `http://SERVER_IP:3232` in their browser
- The server already serves the HTML file at the root URL

---

## Part 3: Firewall Configuration

### Windows Server Firewall

```powershell
# Allow incoming connections on port 3232
netsh advfirewall firewall add rule name="SAP Planner" dir=in action=allow protocol=TCP localport=3232
```

### Linux (ufw)

```bash
sudo ufw allow 3232/tcp
```

### Linux (firewalld)

```bash
sudo firewall-cmd --add-port=3232/tcp --permanent
sudo firewall-cmd --reload
```

---

## Part 4: Security Recommendations

### 1. Change Default Admin Password

Immediately after first login:
1. Login as `admin`
2. Click the user icon in the top-right
3. Select "Passwort ändern"
4. Set a strong password

### 2. Create Individual User Accounts

For each colleague:
1. Login as admin
2. Navigate to user management
3. Create user accounts with appropriate roles:
   - `admin` - Full access (create/edit/delete)
   - `viewer` - Read-only access

### 3. Enable HTTPS (Recommended for Production)

**Option A: Using a reverse proxy (Nginx)**

```nginx
server {
    listen 443 ssl;
    server_name sap-planner.yourcompany.local;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:3232;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

**Option B: Using Node.js HTTPS directly**

Modify `server.js` to use HTTPS module with your SSL certificates.

---

## Part 5: Backup & Maintenance

### Database Backup

The SQLite database is stored in a single file: `sap-planner.db`

**Manual backup:**
```bash
cp sap-planner.db sap-planner-backup-$(date +%Y%m%d).db
```

**Scheduled backup (Linux cron):**
```bash
# Edit crontab
crontab -e

# Add daily backup at 2 AM
0 2 * * * cp /opt/sap-basis-planner/sap-planner.db /backup/sap-planner-$(date +\%Y\%m\%d).db
```

### Server Monitoring

```bash
# Check if server is running
pm2 status

# View logs
pm2 logs sap-planner

# Restart server
pm2 restart sap-planner
```

---

## Part 6: Troubleshooting

| Issue | Solution |
|-------|----------|
| **Cannot connect to server** | Check firewall, verify server is running (`pm2 status`) |
| **"Unexpected token" error** | Server not restarted after code changes - restart with `pm2 restart` |
| **Login fails** | Check username/password, verify server is reachable |
| **CORS errors in browser** | Ensure `baseUrl` matches exactly, including protocol and port |
| **Database locked** | Multiple write operations - wait and retry, or restart server |

---

## Quick Deployment Checklist

### Server Side
- [ ] Copy `server.js` and `package.json` to server
- [ ] Run `npm install`
- [ ] Install PM2: `npm install -g pm2`
- [ ] Start server: `pm2 start server.js --name sap-planner`
- [ ] Configure firewall to allow port 3232
- [ ] Setup auto-start: `pm2 startup && pm2 save`
- [ ] Change default admin password

### Client Side
- [ ] Edit `sap-planner.html` - change `baseUrl` to server address
- [ ] Distribute HTML file to users
- [ ] Create user accounts for each colleague

---

## File Reference

| File | Purpose | Location |
|------|---------|----------|
| `server.js` | Backend API server | Server only |
| `package.json` | Node.js dependencies | Server only |
| `sap-planner.db` | SQLite database | Server only (auto-created) |
| `sap-planner.html` | Frontend application | Distributed to clients |

---

## Support

For issues or questions, check the application logs:
```bash
pm2 logs sap-planner --lines 100
```
