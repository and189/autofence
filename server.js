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

const fencesDbPool = mysql.createPool(fencesDbConfig);
const golbatDbPool = mysql.createPool(golbatDbConfig);
const geofenceDbPool = mysql.createPool(geofenceDbConfig);

// Middleware Setup
app.use(
  cors({
    origin: 'http://0.0.0.0:3005',
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'default_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // Set to true if using HTTPS
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 1 Tag
    },
  })
);

passport.serializeUser((user, done) => {
  done(null, user);
});
passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// Funktion zum Löschen der Geofences eines Benutzers
async function deleteUserFences(discordId) {
  try {
    // Finden des Benutzers in der Datenbank
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (userRows.length === 0) {
      console.log(`Benutzer mit Discord-ID ${discordId} nicht gefunden.`);
      return;
    }
    const userId = userRows[0].id;

    // Finden aller Geofences des Benutzers
    const [fenceRows] = await geofenceDbPool.execute(
      `SELECT g.id
       FROM geofence g
       JOIN geofence_project gp ON g.id = gp.geofence_id
       JOIN project p ON gp.project_id = p.id
       WHERE p.name = ?`,
      [discordId.toString()]
    );

    // Löschen jeder einzelnen Geofence
    for (const fence of fenceRows) {
      const fenceId = fence.id;

      // Löschen aus geofence_project
      await geofenceDbPool.execute(
        'DELETE FROM geofence_project WHERE geofence_id = ?',
        [fenceId]
      );

      // Löschen aus geofence_property
      await geofenceDbPool.execute(
        'DELETE FROM geofence_property WHERE geofence_id = ?',
        [fenceId]
      );

      // Löschen aus geofence
      await geofenceDbPool.execute(
        'DELETE FROM geofence WHERE id = ?',
        [fenceId]
      );

      console.log(`Geofence mit ID ${fenceId} für Benutzer ${discordId} gelöscht.`);
    }
  } catch (error) {
    console.error('Fehler beim Löschen der Geofences des Benutzers:', error);
  }
}

// Discord-Strategie mit Rollenüberprüfung
passport.use(
  new DiscordStrategy(
    {
      clientID: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      callbackURL: process.env.DISCORD_REDIRECT_URI,
      scope: ['identify', 'email', 'guilds', 'guilds.members.read'],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const { id, username, email } = profile;

        // Überprüfen, ob der Benutzer in der Datenbank existiert, andernfalls hinzufügen
        const [rows] = await fencesDbPool.execute(
          'SELECT id FROM users WHERE discord_id = ?',
          [id]
        );
        if (rows.length === 0) {
          const [result] = await fencesDbPool.execute(
            'INSERT INTO users (discord_id, username, email, max_fences) VALUES (?, ?, ?, ?)',
            [id, username, email, 1]
          );
          console.log(`Neuer Benutzer angelegt mit ID: ${result.insertId}`);
        }

        // Überprüfen der Benutzerrolle in der spezifischen Guild
        const guildId = process.env.DISCORD_GUILD_ID; // Die ID der Guild, die Sie überprüfen möchten
        const requiredRoleId = process.env.DISCORD_REQUIRED_ROLE_ID; // Die ID der erforderlichen Rolle

        // Abrufen der Guild-Mitgliedsinformationen
        const memberResponse = await fetch(`https://discord.com/api/guilds/${guildId}/members/${id}`, {
          headers: {
            Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, // Verwenden Sie einen Bot-Token mit den erforderlichen Berechtigungen
          },
        });

        if (!memberResponse.ok) {
          throw new Error('Fehler beim Abrufen der Guild-Mitgliedsinformationen');
        }

        const memberData = await memberResponse.json();
        const userRoles = memberData.roles; // Array von Rollen-IDs

        if (!userRoles.includes(requiredRoleId)) {
          // Benutzer hat die erforderliche Rolle nicht
          // Geofences löschen
          await deleteUserFences(id);
          return done(null, false, { message: 'Benutzer hat nicht die erforderliche Rolle.' });
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

// Routen

// Authentifizierung starten
app.get('/auth/discord', passport.authenticate('discord'));

// Authentifizierung Callback
app.get(
  '/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/unauthorized' }),
  (req, res) => {
    res.redirect('http://164.68.105.51:3005');
  }
);

// Route für nicht autorisierte Benutzer
app.get('/unauthorized', (req, res) => {
  res.status(403).send('Sie besitzen nicht die erforderliche Rolle, um auf diese Anwendung zuzugreifen.');
});

// Benutzerinformationen abrufen
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
        res.json({
          user: req.user,
          last_sync_action: lastSyncAction,
          max_fences: maxFences,
        });
      } else {
        res.json({
          user: req.user,
          last_sync_action: null,
          max_fences: 1,
        });
      }
    } catch (error) {
      console.error('Fehler beim Abrufen von last_sync_action und max_fences:', error);
      res.status(500).json({ error: 'Fehler beim Abrufen der Benutzerdaten' });
    }
  } else {
    res.status(401).json({ error: 'Benutzer nicht authentifiziert' });
  }
});

// Alle Fences eines Benutzers abrufen
app.get('/api/fences', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({
      error: 'Benutzer nicht authentifiziert. Bitte anmelden.',
    });
  }

  try {
    const discordId = req.user.id;
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userId = userRows[0].id;
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
    const [fenceRows] = await geofenceDbPool.execute(
      `SELECT g.id, g.geometry, g.name
       FROM geofence g
       JOIN geofence_project gp ON g.id = gp.geofence_id
       WHERE gp.project_id = ?`,
      [userProjectId]
    );
    const fencesWithOwnership = fenceRows.map((fence) => ({
      id: fence.id,
      geometry: JSON.parse(fence.geometry),
      name: fence.name,
      isOwnFence: true,
    }));
    res.json(fencesWithOwnership);
  } catch (error) {
    console.error('Fehler beim Abrufen der Fences:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Fences' });
  }
});

// Anzahl der Fences eines Benutzers abrufen
app.get('/api/fences/count', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({
      error: 'Benutzer nicht authentifiziert. Bitte anmelden.',
    });
  }

  try {
    const discordId = req.user.id;
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userId = userRows[0].id;
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

// Fences nach Projekt abrufen
app.get('/api/fences/by-project/:projectId', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({
      error: 'Benutzer nicht authentifiziert. Bitte anmelden.',
    });
  }
  const { projectId } = req.params;
  try {
    const parsedProjectId = parseInt(projectId, 10);
    if (isNaN(parsedProjectId)) {
      return res.status(400).json({ error: 'Ungültige Projekt-ID.' });
    }
    const [fenceRows] = await geofenceDbPool.execute(
      `SELECT g.id, g.geometry, g.name, p.name AS ownerDiscordId
       FROM geofence g
       JOIN geofence_project gp ON g.id = gp.geofence_id
       JOIN project p ON gp.project_id = p.id
       WHERE p.id = ?`,
      [parsedProjectId]
    );
    const fences = fenceRows.map((fence) => ({
      id: fence.id,
      geometry: JSON.parse(fence.geometry),
      name: fence.name,
      ownerDiscordId: fence.ownerDiscordId,
      isOwnFence: fence.ownerDiscordId === req.user.id,
    }));
    res.json(fences);
  } catch (error) {
    console.error('Fehler beim Abrufen der Fences für Projekt:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Fences für Projekt' });
  }
});

// Einzelne Fence abrufen
app.get('/api/fences/:id', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Benutzer nicht authentifiziert.' });
  }
  const fenceId = req.params.id;
  try {
    const discordId = req.user.id;
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userId = userRows[0].id;
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
      geometry: fence.geometry,
      name: fence.name,
    });
  } catch (error) {
    console.error('Fehler beim Abrufen der Fence-Daten:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Fence-Daten.' });
  }
});

// Neue Fence erstellen
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
    const [userRows] = await fencesDbPool.execute(
      'SELECT id, max_fences FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userId = userRows[0].id;
    const maxFences = userRows[0].max_fences;
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
      return res
        .status(400)
        .json({ error: `Maximale Anzahl von ${maxFences} Fences erreicht.` });
    }
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
    const formattedGeoJSON = {
      type: 'Polygon',
      coordinates: geojson.geometry.coordinates,
    };
    const [result] = await geofenceDbPool.execute(
      `INSERT INTO geofence (name, created_at, updated_at, mode, geometry, parent)
       VALUES (?, NOW(), NOW(), 'auto_pokemon', ?, NULL)`,
      [name, JSON.stringify(formattedGeoJSON)]
    );
    const geofenceId = result.insertId;
    await geofenceDbPool.execute(
      `INSERT INTO geofence_project (geofence_id, project_id)
       VALUES (?, ?)`,
      [geofenceId, userProjectId]
    );
    const standardProjectIds = [14, 23, 26];
    for (const projectId of standardProjectIds) {
      await geofenceDbPool.execute(
        `INSERT INTO geofence_project (geofence_id, project_id)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE project_id = project_id`,
        [geofenceId, projectId]
      );
    }
    await geofenceDbPool.execute(
      `INSERT INTO geofence_property (geofence_id, property_id, value)
       VALUES (?, 21, ?)`,
      [geofenceId, name]
    );
    res.json({ success: true, fenceId: geofenceId });
  } catch (error) {
    console.error('Fehler beim Speichern der Fence:', error);
    res
      .status(500)
      .json({ error: 'Fehler beim Speichern der Fence', details: error.message });
  }
});

// Fence aktualisieren
app.put('/api/fences/:id', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Benutzer nicht authentifiziert.' });
  }
  const discordId = req.user.id;
  const fenceId = req.params.id;
  const { geojson, name } = req.body;
  if (!geojson && !name) {
    return res.status(400).json({
      error: 'Mindestens ein Feld (geojson oder name) ist erforderlich.',
    });
  }
  try {
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userProjectIdQuery = await geofenceDbPool.execute(
      'SELECT id FROM project WHERE name = ?',
      [discordId.toString()]
    );
    if (userProjectIdQuery[0].length === 0) {
      return res.status(404).json({ error: 'Benutzerprojekt nicht gefunden.' });
    }
    const userProjectId = userProjectIdQuery[0][0].id;
    const [fenceRows] = await geofenceDbPool.execute(
      `SELECT g.id FROM geofence g
       JOIN geofence_project gp ON g.id = gp.geofence_id
       WHERE g.id = ? AND gp.project_id = ?`,
      [fenceId, userProjectId]
    );
    if (fenceRows.length === 0) {
      return res.status(404).json({
        error: 'Fence nicht gefunden oder gehört nicht dem Benutzer.',
      });
    }
    const fields = [];
    const values = [];
    if (geojson) {
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
    if (name) {
      const [existingPropertyRows] = await geofenceDbPool.execute(
        'SELECT * FROM geofence_property WHERE geofence_id = ? AND property_id = 21',
        [fenceId]
      );
      if (existingPropertyRows.length > 0) {
        await geofenceDbPool.execute(
          'UPDATE geofence_property SET value = ? WHERE geofence_id = ? AND property_id = 21',
          [name, fenceId]
        );
      } else {
        await geofenceDbPool.execute(
          'INSERT INTO geofence_property (geofence_id, property_id, value) VALUES (?, 21, ?)',
          [fenceId, name]
        );
      }
    }

    const [fenceNameRows] = await geofenceDbPool.execute(
      'SELECT name FROM geofence WHERE id = ?',
      [fenceId]
    );
    if (fenceNameRows.length > 0) {
      const currentFenceName = fenceNameRows[0].name;
      const areaName = `${discordId.toString()}_${currentFenceName}`;
      const externalApiBaseUrl = process.env.EXTERNAL_API_BASE_URL || 'http://localhost:7272';

      try {
        const listResponse = await fetch(
          `${externalApiBaseUrl}/areas/?order=ASC&page=0&perPage=1000&sortBy=name`,
          { method: 'GET' }
        );
        if (listResponse.ok) {
          const listData = await listResponse.json();
          const userArea = listData.data.find(
            (area) => area.name.toString() === areaName
          );
          if (userArea) {
            const deleteResponse = await fetch(
              `${externalApiBaseUrl}/areas/${userArea.id}`,
              { method: 'DELETE' }
            );
            if (!deleteResponse.ok) {
              const delErrorText = await deleteResponse.text();
              console.error(
                `Fehler beim Löschen der Area: ${deleteResponse.status} ${delErrorText}`
              );
            }
          }
        }
      } catch (err) {
        console.error('Fehler beim Löschen der externen Area:', err);
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Fehler beim Aktualisieren der Fence:', error);
    res.status(500).json({ error: 'Fehler beim Aktualisieren der Fence' });
  }
});

// Fence löschen
app.delete('/api/fences/:id', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Benutzer nicht authentifiziert.' });
  }
  const discordId = req.user.id;
  const fenceId = req.params.id;
  try {
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userProjectIdQuery = await geofenceDbPool.execute(
      'SELECT id FROM project WHERE name = ?',
      [discordId.toString()]
    );
    if (userProjectIdQuery[0].length === 0) {
      return res.status(404).json({ error: 'Benutzerprojekt nicht gefunden.' });
    }
    const userProjectId = userProjectIdQuery[0][0].id;
    const [fenceRows] = await geofenceDbPool.execute(
      `SELECT g.id, g.name
       FROM geofence g
       JOIN geofence_project gp ON g.id = gp.geofence_id
       WHERE g.id = ? AND gp.project_id = ?`,
      [fenceId, userProjectId]
    );
    if (fenceRows.length === 0) {
      return res
        .status(404)
        .json({ error: 'Fence nicht gefunden oder gehört nicht dem Benutzer.' });
    }

    const fenceName = fenceRows[0].name;
    const areaName = `${discordId.toString()}_${fenceName}`;
    const externalApiBaseUrl = process.env.EXTERNAL_API_BASE_URL || 'http://localhost:7272';

    try {
      const listResponse = await fetch(
        `${externalApiBaseUrl}/areas/?order=ASC&page=0&perPage=1000&sortBy=name`,
        { method: 'GET' }
      );
      if (listResponse.ok) {
        const listData = await listResponse.json();
        const userArea = listData.data.find(
          (area) => area.name.toString() === areaName
        );
        if (userArea) {
          const deleteResponse = await fetch(
            `${externalApiBaseUrl}/areas/${userArea.id}`,
            { method: 'DELETE' }
          );
          if (!deleteResponse.ok) {
            const delErrorText = await deleteResponse.text();
            console.error(
              `Fehler beim Löschen der Area: ${deleteResponse.status} ${delErrorText}`
            );
            return res
              .status(deleteResponse.status)
              .json({
                error: `Fehler beim Löschen der externen Area: ${delErrorText}`,
              });
          }
        }
      }
    } catch (err) {
      console.error('Fehler beim Löschen der externen Area:', err);
    }

    await geofenceDbPool.execute(
      'DELETE FROM geofence_project WHERE geofence_id = ?',
      [fenceId]
    );
    await geofenceDbPool.execute(
      'DELETE FROM geofence_property WHERE geofence_id = ?',
      [fenceId]
    );
    await geofenceDbPool.execute('DELETE FROM geofence WHERE id = ?', [fenceId]);

    // Reload externe Dienste
    try {
      await fetch(`http://${process.env.GOLBAT_HOST}:${process.env.GOLBAT_PORT}/api/reload-geojson`, {
        method: 'GET',
        headers: { 'X-Golbat-Secret': process.env.GOLBAT_API_SECRET || '' },
      });
    } catch (err) {
      console.error('Fehler beim Reload Golbat:', err);
    }

    try {
      await fetch(`http://${process.env.PORACLE_HOST}:${process.env.PORACLE_PORT}/api/geofence/reload`, {
        method: 'GET',
        headers: { 'X-Poracle-Secret': process.env.PORACLE_API_SECRET || '' },
      });
    } catch (err) {
      console.error('Fehler beim Reload Poracle:', err);
    }

    try {
      await fetch(`http://${process.env.REACTMAP_HOST}:${process.env.REACTMAP_PORT}/api/v1/area/reload`, {
        method: 'GET',
        headers: { 'react-map-secret': process.env.REACTMAP_API_SECRET || '' },
      });
    } catch (err) {
      console.error('Fehler beim Reload ReactMap:', err);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Fehler beim Löschen der Fence:', error);
    res.status(500).json({ error: 'Fehler beim Löschen der Fence' });
  }
});

// Spawnpoints abrufen
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

// Bootstrap-Daten abrufen
app.get('/api/bootstrap', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res
      .status(401)
      .json({ error: 'Benutzer nicht authentifiziert. Bitte anmelden.' });
  }
  try {
    const discordId = req.user.id;
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userId = userRows[0].id;
    const [bootstrapRows] = await fencesDbPool.execute(
      'SELECT id, fence, route, synced_at FROM bootstrap WHERE user_id = ?',
      [userId]
    );
    if (bootstrapRows.length === 0) {
      return res.json({});
    }
    const bootstrapData = bootstrapRows[0];
    res.json({
      fence: JSON.parse(bootstrapData.fence),
      route: JSON.parse(bootstrapData.route),
      synced_at: bootstrapData.synced_at,
    });
  } catch (error) {
    console.error('Fehler beim Abrufen der Bootstrap-Daten:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Bootstrap-Daten' });
  }
});

// Bootstrap-Daten speichern
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

// Bootstrap-Route löschen
app.delete('/api/bootstrap/route', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Benutzer nicht authentifiziert.' });
  }
  try {
    const discordId = req.user.id;
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userId = userRows[0].id;
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

// Synchronisieren der Geofences
app.post('/api/sync', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Benutzer nicht authentifiziert.' });
  }
  try {
    const { actionType, name } = req.body;
    const discordId = req.user.id;
    if (!name) {
      return res.status(400).json({ error: 'Name der Fence wird benötigt.' });
    }
    const [userRows] = await fencesDbPool.execute(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    }
    const userId = userRows[0].id;
    const externalApiBaseUrl = process.env.EXTERNAL_API_BASE_URL || 'http://localhost:7272';
    const listResponse = await fetch(
      `${externalApiBaseUrl}/areas/?order=ASC&page=0&perPage=1000&sortBy=name`,
      { method: 'GET' }
    );
    if (!listResponse.ok) {
      const errorText = await listResponse.text();
      console.error(`Fehler beim Abrufen der Areas: ${listResponse.status} ${errorText}`);
      return res
        .status(listResponse.status)
        .json({ error: `Fehler beim Abrufen der Areas: ${errorText}` });
    }
    const listData = await listResponse.json();
    const userArea = listData.data.find((area) => area.name.toString() === name);
    if (userArea) {
      const deleteResponse = await fetch(
        `${externalApiBaseUrl}/areas/${userArea.id}`,
        { method: 'DELETE' }
      );
      if (!deleteResponse.ok) {
        const delErrorText = await deleteResponse.text();
        console.error(`Fehler beim Löschen der Area: ${deleteResponse.status} ${delErrorText}`);
        return res
          .status(deleteResponse.status)
          .json({ error: `Fehler beim Löschen der Area: ${delErrorText}` });
      }
      console.log(`Area mit ID ${userArea.id} gelöscht.`);
    }
    if (actionType) {
      await fencesDbPool.execute(
        'UPDATE users SET last_sync_action = ? WHERE discord_id = ?',
        [actionType, discordId]
      );
      console.log(`last_sync_action auf '${actionType}' gesetzt für discord_id: ${discordId}`);
    }
    const responseExternal = await fetch(`${externalApiBaseUrl}/areas/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
      },
      body: JSON.stringify(req.body),
    });
    if (!responseExternal.ok) {
      const errorText = await responseExternal.text();
      console.error(`Fehler beim Synchronisieren: ${responseExternal.status} ${errorText}`);
      return res
        .status(responseExternal.status)
        .json({ error: `Fehler beim Synchronisieren: ${errorText}` });
    }
    const responseData = await responseExternal.json();

    // Reload externe Dienste
    try {
      await fetch(`http://${process.env.GOLBAT_HOST}:${process.env.GOLBAT_PORT}/api/reload-geojson`, {
        method: 'GET',
        headers: { 'X-Golbat-Secret': process.env.GOLBAT_API_SECRET || '' },
      });
    } catch (err) {
      console.error('Fehler beim Reload Golbat:', err);
    }

    try {
      await fetch(`http://${process.env.PORACLE_HOST}:${process.env.PORACLE_PORT}/api/geofence/reload`, {
        method: 'GET',
        headers: { 'X-Poracle-Secret': process.env.PORACLE_API_SECRET || '' },
      });
    } catch (err) {
      console.error('Fehler beim Reload Poracle:', err);
    }

    try {
      await fetch(`http://${process.env.REACTMAP_HOST}:${process.env.REACTMAP_PORT}/api/v1/area/reload`, {
        method: 'GET',
        headers: { 'react-map-secret': process.env.REACTMAP_API_SECRET || '' },
      });
    } catch (err) {
      console.error('Fehler beim Reload ReactMap:', err);
    }

    return res.json({ success: true, data: responseData });
  } catch (error) {
    console.error('Fehler bei /api/sync:', error);
    return res.status(500).json({
      error: 'Interner Serverfehler beim Synchronisieren.',
    });
  }
});

// Cron-Job zum Löschen alter Bootstrap-Routen
cron.schedule('* * * * *', async () => {
  try {
    const [expiredRows] = await fencesDbPool.execute(
      `SELECT b.id, b.user_id, b.fence, b.synced_at, u.discord_id
       FROM bootstrap b
       JOIN users u ON b.user_id = u.id
       WHERE b.synced_at < (NOW() - INTERVAL 30 MINUTE)`
    );
    for (const row of expiredRows) {
      const externalApiBaseUrl = process.env.EXTERNAL_API_BASE_URL || 'http://localhost:7272';
      let fenceName = 'UnnamedFence';
      try {
        const fenceObj = JSON.parse(row.fence);
        if (fenceObj && fenceObj.properties && fenceObj.properties.name) {
          fenceName = fenceObj.properties.name;
        }
      } catch (err) {}

      const areaName = `${row.discord_id}_${fenceName}`;
      try {
        const listResponse = await fetch(
          `${externalApiBaseUrl}/areas/?order=ASC&page=0&perPage=1000&sortBy=name`,
          { method: 'GET' }
        );
        if (listResponse.ok) {
          const listData = await listResponse.json();
          const userArea = listData.data.find((area) => area.name.toString() === areaName);
          if (userArea) {
            const deleteResponse = await fetch(
              `${externalApiBaseUrl}/areas/${userArea.id}`,
              { method: 'DELETE' }
            );
            if (!deleteResponse.ok) {
              const delErrorText = await deleteResponse.text();
              console.error(
                `Fehler beim Löschen der externen Bootstrap-Area: ${deleteResponse.status} ${delErrorText}`
              );
            }
          }
        }
      } catch (err) {
        console.error('Fehler beim Löschen der externen Bootstrap-Area:', err);
      }
      await fencesDbPool.execute('DELETE FROM bootstrap WHERE id = ?', [row.id]);
    }
    if (expiredRows.length > 0) {
      // Reload externe Dienste, falls Routen gelöscht wurden
      try {
        await fetch(`http://${process.env.GOLBAT_HOST}:${process.env.GOLBAT_PORT}/api/reload-geojson`, {
          method: 'GET',
          headers: { 'X-Golbat-Secret': process.env.GOLBAT_API_SECRET || '' },
        });
      } catch (err) {
        console.error('Fehler beim Reload Golbat:', err);
      }
      try {
        await fetch(`http://${process.env.PORACLE_HOST}:${process.env.PORACLE_PORT}/api/geofence/reload`, {
          method: 'GET',
          headers: { 'X-Poracle-Secret': process.env.PORACLE_API_SECRET || '' },
        });
      } catch (err) {
        console.error('Fehler beim Reload Poracle:', err);
      }
      try {
        await fetch(`http://${process.env.REACTMAP_HOST}:${process.env.REACTMAP_PORT}/api/v1/area/reload`, {
          method: 'GET',
          headers: { 'react-map-secret': process.env.REACTMAP_API_SECRET || '' },
        });
      } catch (err) {
        console.error('Fehler beim Reload ReactMap:', err);
      }
    }
  } catch (err) {
    console.error('Cron-Fehler beim Löschen alter Bootstrap-Routen:', err);
  }
});

// Starten des Servers
app.listen(port, process.env.SERVER_HOST || '0.0.0.0', () => {
  console.log(
    `Server läuft auf http://${process.env.SERVER_HOST || 'localhost'}:${port}`
  );
});
