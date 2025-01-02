// server.js

import express from 'express';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import cors from 'cors';
import passport from 'passport';
import DiscordStrategy from 'passport-discord';
import session from 'express-session';
import fetch from 'node-fetch';
import cron from 'node-cron';

dotenv.config();

const app = express();
const port = process.env.SERVER_PORT || 3010;

// Verbindung zu den Datenbanken
const fencesDbConfig = {
  host: process.env.FENCES_DB_HOST,
  user: process.env.FENCES_DB_USER,
  password: process.env.FENCES_DB_PASSWORD,
  database: process.env.FENCES_DB_NAME,
};

const golbatDbConfig = {
  host: process.env.GOLBAT_DB_HOST,
  user: process.env.GOLBAT_DB_USER,
  password: process.env.GOLBAT_DB_PASSWORD,
  database: process.env.GOLBAT_DB_NAME,
};

const geofenceDbConfig = {
  host: process.env.GEOFENCE_DB_HOST,
  user: process.env.GEOFENCE_DB_USER,
  password: process.env.GEOFENCE_DB_PASSWORD,
  database: process.env.GEOFENCE_DB_NAME,
};

// Erstelle Datenbank-Pools
const fencesDbPool = mysql.createPool(fencesDbConfig);
const golbatDbPool = mysql.createPool(golbatDbConfig);
const geofenceDbPool = mysql.createPool(geofenceDbConfig);

// Middleware
app.use(
  cors({
    origin: 'http://0.0.0.0:3005', // Die URL deines Frontends
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session Middleware
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'default_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 1 Tag
    },
  })
);

// Passport-Konfiguration
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// Discord OAuth2 Strategien
passport.use(
  new DiscordStrategy(
    {
      clientID: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      callbackURL: process.env.DISCORD_REDIRECT_URI,
      scope: ['identify', 'email'],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const { id, username, email } = profile;

        // Überprüfen, ob der Benutzer in der Datenbank ist
        const [rows] = await fencesDbPool.execute(
          'SELECT id FROM users WHERE discord_id = ?',
          [id]
        );

        if (rows.length === 0) {
          // Benutzer in die Datenbank einfügen, falls er nicht existiert
          const [result] = await fencesDbPool.execute(
            'INSERT INTO users (discord_id, username, email, max_fences) VALUES (?, ?, ?, ?) ',
            [id, username, email, 1] // Setze die maximale Anzahl an Fences hier
          );
          console.log(`Neuer Benutzer angelegt mit ID: ${result.insertId}`);
        }

        done(null, profile);
      } catch (err) {
        console.error('Fehler bei der Benutzerregistrierung:', err);
        done(err, null);
      }
    }
  )
);

app.use(passport.initialize());
app.use(passport.session());

// Authentifizieren mit Discord
app.get('/auth/discord', passport.authenticate('discord'));

// Callback-Route für Discord
app.get(
  '/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => {
    res.redirect('http://164.68.105.51:3005'); // Weiterleitung zur Karte
  }
);

// **Benutzer-API mit last_sync_action und max_fences**
app.get('/api/user', async (req, res) => {
  if (req.isAuthenticated()) {
    try {
      const discordId = req.user.id;
      const [rows] = await fencesDbPool.execute(
        'SELECT last_sync_action, max_fences FROM users WHERE discord_id = ?',
        [discordId]
      );
      if (rows.length > 0) {
        const lastSyncAction = rows[0].last_sync_action;
        const maxFences = rows[0].max_fences;
        res.json({ user: req.user, last_sync_action: lastSyncAction, max_fences: maxFences });
      } else {
        res.json({ user: req.user, last_sync_action: null, max_fences: 1 }); // Standardwert 1, falls nicht gesetzt
      }
    } catch (error) {
      console.error('Fehler beim Abrufen von last_sync_action und max_fences:', error);
      res.status(500).json({ error: 'Fehler beim Abrufen der Benutzerdaten' });
    }
  } else {
    res.status(401).json({ error: 'Benutzer nicht authentifiziert' });
  }
});

// **API-Route: /api/fences zum Abrufen aller eigenen Fences**
app.get('/api/fences', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res
      .status(401)
      .json({ error: 'Benutzer nicht authentifiziert. Bitte anmelden.' });
  }

  try {
    const discordId = req.user.id; // Discord-ID des Benutzers

    // Hole die Benutzer-ID des aktuellen Benutzers
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userId = userRows[0].id;

    // Hole die Projekt-ID des Benutzers (angenommen, es gibt ein Projekt pro Benutzer)
    const [projectRows] = await geofenceDbPool.execute(
      'SELECT id FROM project WHERE name = ?',
      [discordId.toString()]
    );

    let userProjectId;
    if (projectRows.length > 0) {
      userProjectId = projectRows[0].id;
    } else {
      // Falls kein Projekt existiert, erstelle eines
      const [projectResult] = await geofenceDbPool.execute(
        `INSERT INTO project (name, created_at, updated_at, api_endpoint, api_key, scanner, description)
            VALUES (?, NOW(), NOW(), NULL, NULL, 0, 'Auto-generated for Discord user')`,
        [discordId.toString()]
      );
      userProjectId = projectResult.insertId;
      console.log(`Neues Projekt für Benutzer erstellt mit ID: ${userProjectId}`);
    }

    // Hole die Fences, die zum Benutzerprojekt gehören
    const [fenceRows] = await geofenceDbPool.execute(
      `SELECT g.id, g.geometry, g.name 
         FROM geofence g 
         JOIN geofence_project gp ON g.id = gp.geofence_id 
         WHERE gp.project_id = ?`,
      [userProjectId]
    );

    // Füge die Fences in das Format für das Frontend
    const fencesWithOwnership = fenceRows.map((fence) => ({
      id: fence.id,
      geometry: JSON.parse(fence.geometry),
      name: fence.name,
      isOwnFence: true, // Da wir nur die eigenen Fences abrufen
    }));

    console.log(`Alle eigenen Fences: ${JSON.stringify(fencesWithOwnership)}`);
    res.json(fencesWithOwnership);
  } catch (error) {
    console.error('Fehler beim Abrufen der Fences:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Fences' });
  }
});

// **API-Route: /api/fences/count zum Zählen der Fences**
app.get('/api/fences/count', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res
      .status(401)
      .json({ error: 'Benutzer nicht authentifiziert. Bitte anmelden.' });
  }

  try {
    const discordId = req.user.id;

    // Hole die Benutzer-ID des aktuellen Benutzers
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userId = userRows[0].id;

    // Zähle die Anzahl der Fences des Benutzers
    const [countRows] = await geofenceDbPool.execute(
      `SELECT COUNT(*) AS count
         FROM geofence g
         JOIN geofence_project gp ON g.id = gp.geofence_id
         JOIN project p ON gp.project_id = p.id
         WHERE p.name = ?`,
      [discordId.toString()]
    );

    const fenceCount = countRows[0].count;
    res.json({ count: fenceCount });
  } catch (error) {
    console.error('Fehler beim Zählen der Fences:', error);
    res.status(500).json({ error: 'Fehler beim Zählen der Fences' });
  }
});

// **API-Route: /api/fences/by-project/:projectId zum Abrufen aller Fences eines bestimmten Projekts**
app.get('/api/fences/by-project/:projectId', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res
      .status(401)
      .json({ error: 'Benutzer nicht authentifiziert. Bitte anmelden.' });
  }

  const { projectId } = req.params;

  try {
    // Validierung der projectId
    const parsedProjectId = parseInt(projectId, 10);
    if (isNaN(parsedProjectId)) {
      return res.status(400).json({ error: 'Ungültige Projekt-ID.' });
    }

    // Hole die Fences, die zum angegebenen Projekt gehören
    const [fenceRows] = await geofenceDbPool.execute(
      `SELECT g.id, g.geometry, g.name, p.name AS ownerDiscordId
         FROM geofence g
         JOIN geofence_project gp ON g.id = gp.geofence_id
         JOIN project p ON gp.project_id = p.id
         WHERE p.id = ?`,
      [parsedProjectId]
    );

    // Füge die Fences in das Format für das Frontend
    const fences = fenceRows.map((fence) => ({
      id: fence.id,
      geometry: JSON.parse(fence.geometry),
      name: fence.name,
      ownerDiscordId: fence.ownerDiscordId,
      isOwnFence: fence.ownerDiscordId === req.user.id, // Prüfen, ob die Fence dem aktuellen Benutzer gehört
    }));

    console.log(`Fences für Projekt ${projectId}: ${JSON.stringify(fences)}`);
    res.json(fences);
  } catch (error) {
    console.error('Fehler beim Abrufen der Fences für Projekt:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Fences für Projekt' });
  }
});

// **API-Route: /api/fences/:id zum Abrufen einer einzelnen Fence**
app.get('/api/fences/:id', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Benutzer nicht authentifiziert.' });
  }

  const fenceId = req.params.id;

  try {
    const discordId = req.user.id;

    // Hole die Benutzer-ID
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }

    const userId = userRows[0].id;

    // Hole die Fence-Daten, stelle sicher, dass die Fence dem Benutzer gehört
    const [fenceRows] = await geofenceDbPool.execute(
      `SELECT g.id, g.geometry, g.name 
         FROM geofence g
         JOIN geofence_project gp ON g.id = gp.geofence_id
         JOIN project p ON gp.project_id = p.id
         WHERE g.id = ? AND p.name = ?`,
      [fenceId, discordId.toString()]
    );

    if (fenceRows.length === 0) {
      return res
        .status(404)
        .json({ error: 'Fence nicht gefunden oder gehört nicht dem Benutzer.' });
    }

    const fence = fenceRows[0];
    res.json({
      id: fence.id,
      geometry: fence.geometry, // Stelle sicher, dass das Format konsistent ist
      name: fence.name,
    });
  } catch (error) {
    console.error('Fehler beim Abrufen der Fence-Daten:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Fence-Daten.' });
  }
});

// **API-Route: /api/fences zum Erstellen einer neuen Fence**
app.post('/api/fences', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Benutzer nicht authentifiziert.' });
  }

  const discordId = req.user.id;
  const { geojson, name } = req.body;

  if (!geojson) {
    return res.status(400).json({ error: 'GeoJSON-Daten werden benötigt.' });
  }

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'Ein gültiger Name ist erforderlich.' });
  }

  try {
    // Überprüfen, ob der Benutzer in der Datenbank ist
    const [userRows] = await fencesDbPool.execute(
      'SELECT id, max_fences FROM users WHERE discord_id = ?',
      [discordId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }

    const userId = userRows[0].id;
    const maxFences = userRows[0].max_fences; // Nutze den Wert der max_fences-Spalte

    // Überprüfen der Anzahl der vorhandenen Fences
    const [countRows] = await geofenceDbPool.execute(
      `SELECT COUNT(*) AS count
         FROM geofence g
         JOIN geofence_project gp ON g.id = gp.geofence_id
         JOIN project p ON gp.project_id = p.id
         WHERE p.name = ?`,
      [discordId.toString()]
    );

    const fenceCount = countRows[0].count;

    if (fenceCount >= maxFences) {
      return res.status(400).json({ error: `Maximale Anzahl von ${maxFences} Fences erreicht.` });
    }

    // Hole oder erstelle das Benutzerprojekt
    const [projectRows] = await geofenceDbPool.execute(
      'SELECT id FROM project WHERE name = ?',
      [discordId.toString()]
    );

    let userProjectId;
    if (projectRows.length > 0) {
      userProjectId = projectRows[0].id;
    } else {
      const [projectResult] = await geofenceDbPool.execute(
        `INSERT INTO project (name, created_at, updated_at, api_endpoint, api_key, scanner, description)
            VALUES (?, NOW(), NOW(), NULL, NULL, 0, 'Auto-generated for Discord user')`,
        [discordId.toString()]
      );
      userProjectId = projectResult.insertId;
      console.log(`Neues Projekt für Benutzer erstellt mit ID: ${userProjectId}`);
    }

    // Umwandlung der Geometrie in das gewünschte Format
    const formattedGeoJSON = {
      type: 'Polygon',
      coordinates: geojson.geometry.coordinates,
    };

    // Speichern der neuen Geofence
    const [result] = await geofenceDbPool.execute(
      `INSERT INTO geofence (name, created_at, updated_at, mode, geometry, parent)
          VALUES (?, NOW(), NOW(), 'auto_pokemon', ?, NULL)`,
      [name, JSON.stringify(formattedGeoJSON)]
    );

    const geofenceId = result.insertId;

    // Projekt zuordnen (das erstellte Benutzerprojekt)
    await geofenceDbPool.execute(
      `INSERT INTO geofence_project (geofence_id, project_id)
          VALUES (?, ?)`,
      [geofenceId, userProjectId]
    );

    // Füge die Standardprojekte (14, 23, 26) hinzu
    const standardProjectIds = [14, 23, 26]; // Anpassen der IDs falls notwendig

    for (const projectId of standardProjectIds) {
      await geofenceDbPool.execute(
        `INSERT INTO geofence_project (geofence_id, project_id)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE project_id = project_id`, // Auf Duplikate absichern
        [geofenceId, projectId]
      );
    }

    // **Neuer Code: Einfügen in geofence_property**
    await geofenceDbPool.execute(
      `INSERT INTO geofence_property (geofence_id, property_id, value)
          VALUES (?, 21, ?)`,
      [geofenceId, name]
    );

    console.log(`Neue Fence mit ID ${geofenceId} für Benutzer erstellt.`);
    res.json({ success: true, fenceId: geofenceId });
  } catch (error) {
    console.error('Fehler beim Speichern der Fence:', error);
    res.status(500).json({ error: 'Fehler beim Speichern der Fence', details: error.message });
  }
});

// **API-Route: /api/fences/:id zum Aktualisieren einer bestehenden Fence**
app.put('/api/fences/:id', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Benutzer nicht authentifiziert.' });
  }

  const discordId = req.user.id;
  const fenceId = req.params.id;
  const { geojson, name } = req.body;

  if (!geojson && !name) {
    return res
      .status(400)
      .json({ error: 'Mindestens ein Feld (geojson oder name) ist erforderlich.' });
  }

  try {
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }

    const userId = userRows[0].id;

    // Hole das Benutzerprojekt
    const [projectRows] = await geofenceDbPool.execute(
      'SELECT id FROM project WHERE name = ?',
      [discordId.toString()]
    );

    if (projectRows.length === 0) {
      return res.status(404).json({ error: 'Benutzerprojekt nicht gefunden.' });
    }

    const userProjectId = projectRows[0].id;

    // Überprüfe, ob die Fence dem Benutzer gehört
    const [fenceRows] = await geofenceDbPool.execute(
      `SELECT g.id FROM geofence g
         JOIN geofence_project gp ON g.id = gp.geofence_id
         WHERE g.id = ? AND gp.project_id = ?`,
      [fenceId, userProjectId]
    );

    if (fenceRows.length === 0) {
      return res
        .status(404)
        .json({ error: 'Fence nicht gefunden oder gehört nicht dem Benutzer.' });
    }

    // Aktualisiere das Geofence in der Geofence-Datenbank
    const fields = [];
    const values = [];

    if (geojson) {
      // Extrahiere nur die Geometrie und stelle sicher, dass der Typ "Polygon" ist
      const formattedGeoJSON = {
        type: 'Polygon',
        coordinates: geojson.geometry.coordinates,
      };
      fields.push('geometry = ?');
      values.push(JSON.stringify(formattedGeoJSON));
    }

    if (name) {
      fields.push('name = ?');
      values.push(name);
    }

    values.push(fenceId);

    const updateQuery = `UPDATE geofence SET ${fields.join(', ')} WHERE id = ?`;
    await geofenceDbPool.execute(updateQuery, values);

    // Aktualisiere geofence_property, falls der Name geändert wurde
    if (name) {
      // Überprüfe, ob bereits ein Eintrag existiert
      const [existingPropertyRows] = await geofenceDbPool.execute(
        'SELECT * FROM geofence_property WHERE geofence_id = ? AND property_id = 21',
        [fenceId]
      );

      if (existingPropertyRows.length > 0) {
        // Eintrag existiert, führe ein UPDATE durch
        await geofenceDbPool.execute(
          'UPDATE geofence_property SET value = ? WHERE geofence_id = ? AND property_id = 21',
          [name, fenceId]
        );
      } else {
        // Eintrag existiert nicht, füge ihn ein
        await geofenceDbPool.execute(
          'INSERT INTO geofence_property (geofence_id, property_id, value) VALUES (?, 21, ?)',
          [fenceId, name]
        );
      }
    }
    console.log(`Fence mit ID ${fenceId} aktualisiert.`);
    res.json({ success: true });
  } catch (error) {
    console.error('Fehler beim Aktualisieren der Fence:', error);
    res.status(500).json({ error: 'Fehler beim Aktualisieren der Fence' });
  }
});

// **API-Route: /api/spawnpoints**
app.get('/api/spawnpoints', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res
      .status(401)
      .json({ error: 'Benutzer nicht authentifiziert. Bitte anmelden.' });
  }

  const { north, south, east, west } = req.query;

  if (
    !north ||
    !south ||
    !east ||
    !west ||
    isNaN(north) ||
    isNaN(south) ||
    isNaN(east) ||
    isNaN(west)
  ) {
    return res
      .status(400)
      .json({ error: 'Ungültige Eingabe. Alle Werte müssen Zahlen sein.' });
  }

  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

  try {
    const [rows] = await golbatDbPool.execute(
      'SELECT id, lat, lon FROM spawnpoint WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND last_seen >= ?',
      [south, north, west, east, thirtyDaysAgo]
    );
    res.json(rows);
  } catch (error) {
    console.error('Fehler beim Abrufen der Spawnpunkte:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Spawnpunkte' });
  }
});

// **API-Route: /api/bootstrap zum Abrufen des Bootstrap-Fence und Route**
app.get('/api/bootstrap', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res
      .status(401)
      .json({ error: 'Benutzer nicht authentifiziert. Bitte anmelden.' });
  }

  try {
    const discordId = req.user.id; // Discord-ID des Benutzers

    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userId = userRows[0].id;

    const [bootstrapRows] = await fencesDbPool.execute(
      'SELECT fence, route, synced_at FROM bootstrap WHERE user_id = ?',
      [userId]
    );

    if (bootstrapRows.length === 0) {
      return res.json({});
    }

    const bootstrapData = bootstrapRows[0];
    res.json({
      fence: JSON.parse(bootstrapData.fence),
      route: JSON.parse(bootstrapData.route),
      synced_at: bootstrapData.synced_at, // optional, falls du das auswerten willst
    });
  } catch (error) {
    console.error('Fehler beim Abrufen der Bootstrap-Daten:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Bootstrap-Daten' });
  }
});

// **API-Route: /api/bootstrap zum Speichern der Bootstrap-Fence und Route**
app.post('/api/bootstrap', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Benutzer nicht authentifiziert.' });
  }

  const discordId = req.user.id;
  const { fence, route } = req.body;

  if (!fence || !route) {
    return res.status(400).json({ error: 'Fence und Route werden benötigt.' });
  }

  try {
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userId = userRows[0].id;

    // Überprüfen, ob es bereits eine Bootstrap-Fence für den Benutzer gibt
    const [existingBootstrapRows] = await fencesDbPool.execute(
      'SELECT id FROM bootstrap WHERE user_id = ?',
      [userId]
    );

    if (existingBootstrapRows.length === 0) {
      await fencesDbPool.execute(
        'INSERT INTO bootstrap (user_id, fence, route, synced_at) VALUES (?, ?, ?, NOW())',
        [userId, JSON.stringify(fence), JSON.stringify(route)]
      );
    } else {
      await fencesDbPool.execute(
        'UPDATE bootstrap SET fence = ?, route = ?, synced_at = NOW() WHERE user_id = ?',
        [JSON.stringify(fence), JSON.stringify(route), userId]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Fehler beim Speichern der Bootstrap-Daten:', error);
    res.status(500).json({ error: 'Fehler beim Speichern der Bootstrap-Daten' });
  }
});

// **Neuer Endpoint: Nur die Bootstrap-Route löschen**
app.delete('/api/bootstrap/route', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Benutzer nicht authentifiziert.' });
  }

  try {
    const discordId = req.user.id;
    // User abfragen
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userId = userRows[0].id;

    // Setze nur die route auf NULL, synced_at belassen (oder auch wieder auf NULL setzen, je nach Bedarf)
    await fencesDbPool.execute(
      'UPDATE bootstrap SET route = NULL WHERE user_id = ?',
      [userId]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('Fehler beim Löschen der Bootstrap-Route:', error);
    res.status(500).json({ error: 'Fehler beim Löschen der Bootstrap-Route.' });
  }
});

// **API-Route: /api/sync zum Weiterleiten an externe API**
app.post('/api/sync', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Benutzer nicht authentifiziert.' });
  }

  try {
    const { actionType, name } = req.body; // Extrahiere `name` aus dem Payload
    const discordId = req.user.id;

    if (!name) {
      return res.status(400).json({ error: 'Name der Fence wird benötigt.' });
    }

    // userId abfragen
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }

    const userId = userRows[0].id;
    console.log(`Aktueller discordId: ${discordId}, userId: ${userId}`);

    // Lösche nur die Area mit dem exakten Namen
    console.log(
      `Synchronisiere Area. Überprüfe und lösche vorhandene Area mit dem Namen: ${name}.`
    );

    // Suche nach Area-Bereich mit exakt passendem Namen
    const externalApiBaseUrl = process.env.EXTERNAL_API_BASE_URL || 'http://localhost:7272';
    const listResponse = await fetch(
      `${externalApiBaseUrl}/areas/?order=ASC&page=0&perPage=1000&sortBy=name`,
      { method: 'GET' }
    );

    if (!listResponse.ok) {
      const errorText = await listResponse.text();
      console.error(
        `Fehler beim Abrufen der Areas: ${listResponse.status} ${errorText}`
      );
      return res.status(listResponse.status).json({
        error: `Fehler beim Abrufen der Areas: ${errorText}`,
      });
    }

    const listData = await listResponse.json();
    console.log('Erhaltene Areas von der externen API:', listData);

    // Finde die Area mit dem exakten Namen
    const userArea = listData.data.find(
      (area) => area.name.toString() === name
    );
    console.log(`Gesuchte Area mit Namen '${name}':`, userArea);

    if (userArea) {
      console.log(`Versuche, Area mit ID ${userArea.id} zu löschen.`);
      // Lösche die Area
      const deleteResponse = await fetch(
        `${externalApiBaseUrl}/areas/${userArea.id}`,
        { method: 'DELETE' }
      );

      if (!deleteResponse.ok) {
        const delErrorText = await deleteResponse.text();
        console.error(
          `Fehler beim Löschen der Area: ${deleteResponse.status} ${delErrorText}`
        );
        return res.status(deleteResponse.status).json({
          error: `Fehler beim Löschen der Area: ${delErrorText}`,
        });
      }

      console.log(`Area mit ID ${userArea.id} gelöscht.`);
    } else {
      console.log('Keine Area gefunden, die gelöscht werden müsste.');
    }

    // Update `last_sync_action`
    if (actionType) {
      await fencesDbPool.execute(
        'UPDATE users SET last_sync_action = ? WHERE discord_id = ?',
        [actionType, discordId]
      );
      console.log(
        `last_sync_action auf '${actionType}' gesetzt für discord_id: ${discordId}`
      );
    }

    // Neue Area anlegen
    console.log('Neues Area-Objekt, das an die externe API gesendet wird:', req.body);
    const responseExternal = await fetch(`${externalApiBaseUrl}/areas/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
      },
      body: JSON.stringify(req.body),
    });

    console.log(`Antwort der externen API: Status ${responseExternal.status}`);
    if (!responseExternal.ok) {
      const errorText = await responseExternal.text();
      console.error(`Fehler beim Synchronisieren: ${responseExternal.status} ${errorText}`);
      return res.status(responseExternal.status).json({
        error: `Fehler beim Synchronisieren: ${errorText}`,
      });
    }

    const responseData = await responseExternal.json();
    console.log('Erfolg:', responseData);
    return res.json({ success: true, data: responseData });
  } catch (error) {
    console.error('Fehler bei /api/sync:', error);
    return res.status(500).json({
      error: 'Interner Serverfehler beim Synchronisieren.',
    });
  }
});

// SERVERSEITIGE CRON-JOB LÖSUNG
// Alle Minute prüfen wir, ob in "bootstrap" Einträge älter als 30 min (synced_at) sind,
// und setzen deren route auf NULL.
cron.schedule('* * * * *', async () => {
  try {
    console.log('Cron-Job läuft: Prüfe alte Bootstrap-Routen...');

    await fencesDbPool.execute(
      `UPDATE bootstrap
         SET route = NULL
         WHERE route IS NOT NULL
           AND synced_at < (NOW() - INTERVAL 30 MINUTE)`
    );

    console.log('Alte Bootstrap-Routen erfolgreich entfernt.');
  } catch (err) {
    console.error('Cron-Fehler beim Löschen alter Bootstrap-Routen:', err);
  }
});

// Starte den Server
app.listen(port, process.env.SERVER_HOST || '0.0.0.0', () => {
  console.log(
    `Server läuft auf http://${process.env.SERVER_HOST || 'localhost'}:${port}`
  );
});
