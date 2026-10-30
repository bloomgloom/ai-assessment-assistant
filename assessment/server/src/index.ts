import express from 'express';
import cors from 'cors';
import path from 'path';
import { initDb } from './services/db';
import { initAssignmentDb } from './services/assignmentDb';

import settingsRouter from './routes/settings';
import criteriaRouter from './routes/criteria';
import classesRouter from './routes/classes';
import recordsRouter from './routes/records';
import artifactsRouter from './routes/artifacts';
import aiRouter from './routes/ai';
import assignmentConfigsRouter from './routes/assignmentConfigs';
import lessonPlansRouter from './routes/lessonPlans';
import activityRouter from './routes/activity';

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:3001'], credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use('/api/settings', settingsRouter);
app.use('/api/criteria', criteriaRouter);
app.use('/api/classes', classesRouter);
app.use('/api/records', recordsRouter);
app.use('/api/artifacts', artifactsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/assignment-configs', assignmentConfigsRouter);
app.use('/api/lesson-plans', lessonPlansRouter);
app.use('/api/activity', activityRouter);

// 프로덕션: 빌드된 클라이언트 서빙
const clientDist = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  const indexPath = path.join(clientDist, 'index.html');
  if (require('fs').existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Client not built. Run: npm run build --workspace=client');
  }
});

async function main() {
  await initDb();
  await initAssignmentDb();
  app.listen(Number(PORT), HOST, () => {
    console.log(`✅ Assessment server running at http://${HOST}:${PORT}`);
  });
}

main().catch(console.error);
