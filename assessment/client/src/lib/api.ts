import axios from 'axios';

const api = axios.create({ baseURL: '/api' });
// Leave one minute for the app server to return its 10-minute provider timeout.
const CLAUDE_BATCH_SUBMIT_TIMEOUT_MS = 11 * 60 * 1000;

export default api;

// Settings
export const settingsApi = {
  get: () => api.get('/settings'),
  update: (data: Record<string, unknown>) => api.put('/settings', data),
  test: (data?: Record<string, unknown>) => api.post('/settings/test', data || {}),
  reset: () => api.post('/settings/reset'),
  backup: () => api.get('/settings/backup', { responseType: 'blob' }),
  restore: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post('/settings/restore', form);
  },
  getProviderModels: (provider: string, baseUrl: string, apiKey: string) =>
    api.get('/settings/models', { params: { provider, baseUrl, apiKey } }),
  getCompatibleModels: (baseUrl: string, apiKey: string) =>
    api.get('/settings/models', { params: { provider: 'openai-compatible', baseUrl, apiKey } }),
};

// Criteria (Domain Based)
export const criteriaApi = {
  getSets: () => api.get('/criteria/sets', { params: { t: Date.now() } }), // legacy
  getSubjects: (type?: 'standards' | 'domains') => api.get('/criteria/subjects', { params: { type, t: Date.now() } }),
  getDomainSubjects: () => api.get('/criteria/domain-subjects', { params: { t: Date.now() } }),
  getStandardSubjects: () => api.get('/criteria/standard-subjects', { params: { t: Date.now() } }),
  getDomains: (year: number, semester: number, grade: number, subject: string) =>
    api.get('/criteria/domains', { params: { year, semester, grade, subject, t: Date.now() } }),
  uploadDomains: (file: File, overwrite?: boolean) => {
    const form = new FormData();
    form.append('file', file);
    return api.post(`/criteria/domains/upload${overwrite ? '?overwrite=true' : ''}`, form);
  },
  exportSubjectConfig: (year: number, semester: number, grade: number, subject: string) =>
    api.get('/criteria/subject-config/export', {
      params: { year, semester, grade, subject },
      responseType: 'blob',
    }),
  importSubjectConfig: (year: number, semester: number, grade: number, subject: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    form.append('year', String(year));
    form.append('semester', String(semester));
    form.append('grade', String(grade));
    form.append('subject', subject);
    return api.post('/criteria/subject-config/upload', form);
  },
  exportDomainConfig: (year: number, semester: number, grade: number, subject: string, domainName: string) =>
    api.get('/criteria/domain-config/export', {
      params: { year, semester, grade, subject, domainName },
      responseType: 'blob',
    }),
  importDomainConfig: (year: number, semester: number, grade: number, subject: string, domainName: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    form.append('year', String(year));
    form.append('semester', String(semester));
    form.append('grade', String(grade));
    form.append('subject', subject);
    form.append('domainName', domainName);
    return api.post('/criteria/domain-config/upload', form);
  },
  importDomainConfigFile: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post('/criteria/domain-config/upload', form);
  },
  sourceUrl: (kind: 'domains' | 'standards', year: number, semester: number, grade: number, subject: string) =>
    `/api/criteria/${kind}/source-file?year=${year}&semester=${semester}&grade=${grade}&subject=${encodeURIComponent(subject)}`,
  downloadSource: (kind: 'domains' | 'standards', year: number, semester: number, grade: number, subject: string) =>
    api.get(`/criteria/${kind}/source-file`, {
      params: { year, semester, grade, subject },
      responseType: 'blob',
    }),
  deleteSource: (kind: 'domains' | 'standards', year: number, semester: number, grade: number, subject: string) =>
    api.delete(`/criteria/${kind}/source-file`, { params: { year, semester, grade, subject } }),
  getStandards: (year: number, semester: number, grade: number, subject: string) =>
    api.get('/criteria/standards', { params: { year, semester, grade, subject, t: Date.now() } }),
  uploadStandards: (file: File, overwrite?: boolean) => {
    const form = new FormData();
    form.append('file', file);
    return api.post(`/criteria/standards/upload${overwrite ? '?overwrite=true' : ''}`, form);
  },
  exportStandardsConfig: (year: number, semester: number, grade: number, subject: string, domainName: string) =>
    api.get('/criteria/standards-config/export', {
      params: { year, semester, grade, subject, domainName },
      responseType: 'blob',
    }),
  importStandardsConfig: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post('/criteria/standards-config/upload', form);
  },
  addManualStandardDomain: (data: {
    year: number;
    semester: number;
    grade: number;
    subject: string;
    credit?: number;
    domainName: string;
  }) => api.post('/criteria/standards/manual-domain', data),
  seedStandardsFromCurriculum: (data: {
    year: number;
    semester: number;
    grade: number;
    subject: string;
    credit?: number;
  }) => api.post('/criteria/standards/from-curriculum', data),
  createStandardsAnchor: (year: number, semester: number, grade: number, subject: string) =>
    api.post('/criteria/standards/anchor', { year, semester, grade, subject }),
  createDomainsAnchor: (year: number, semester: number, grade: number, subject: string) =>
    api.post('/criteria/domains/anchor', { year, semester, grade, subject }),
  deleteStandardsScope: (params: {
    year: number;
    semester?: number;
    grade?: number;
    subject?: string;
    domainName?: string;
  }) => api.delete('/criteria/standards/scope', { params }),
  updateStandardsScope: (data: {
    from: { year: number; semester?: number; grade?: number; subject?: string; domainName?: string };
    to: { year?: number; semester?: number; grade?: number; subject?: string; domainName?: string };
  }) => api.put('/criteria/standards/scope', data),
  deleteDomainsScope: (params: {
    year: number;
    semester?: number;
    grade?: number;
    subject?: string;
    domainName?: string;
  }) => api.delete('/criteria/domains/scope', { params }),
  updateDomainsScope: (data: {
    from: { year: number; semester?: number; grade?: number; subject?: string; domainName?: string };
    to: { year?: number; semester?: number; grade?: number; subject?: string; domainName?: string };
  }) => api.put('/criteria/domains/scope', data),
  getSubjectDomains: (year: number, semester: number, grade: number, subject: string) =>
    api.get('/criteria/subject-domains', { params: { year, semester, grade, subject, t: Date.now() } }),
  bulkSaveSubjectDomains: (year: number, semester: number, grade: number, subject: string, rows: unknown[]) =>
    api.put('/criteria/subject-domains/bulk', { year, semester, grade, subject, rows }),
  addCustomDomain: (data: { year: number, semester: number, grade: number, subject: string, name: string }) =>
    api.post('/criteria/custom-domains', data),
  updateCustomDomain: (id: number, data: { name: string }) => api.put(`/criteria/custom-domains/${id}`, data),
  deleteCustomDomain: (id: number) => api.delete(`/criteria/custom-domains/${id}`),

  // 세특
  getComments: (year: number, semester: number, grade: number, subject: string, domainName: string) =>
    api.get('/criteria/comments', { params: { year, semester, grade, subject, domainName, t: Date.now() } }),
  bulkSaveComments: (year: number, semester: number, grade: number, subject: string, domainName: string, items: unknown[]) =>
    api.put('/criteria/comments/bulk', { year, semester, grade, subject, domainName, items }),

  // 평가
  getEval: (year: number, semester: number, grade: number, subject: string, domainName: string) =>
    api.get('/criteria/eval', { params: { year, semester, grade, subject, domainName, t: Date.now() } }),
  bulkSaveEval: (year: number, semester: number, grade: number, subject: string, domainName: string, items: unknown[]) =>
    api.put('/criteria/eval/bulk', { year, semester, grade, subject, domainName, items }),
  getAiPrompts: (year: number, semester: number, grade: number, subject: string, domainName: string) =>
    api.get('/criteria/ai-prompts', { params: { year, semester, grade, subject, domainName, t: Date.now() } }),
  bulkSaveAiPrompts: (year: number, semester: number, grade: number, subject: string, domainName: string, prompts: unknown[]) =>
    api.put('/criteria/ai-prompts/bulk', { year, semester, grade, subject, domainName, prompts }),
};

// Records / Sessions
export const recordsApi = {
  getSessions: () => api.get('/records/sessions'),
  createSession: (data: { name: string; criteria_id?: number }) =>
    api.post('/records/sessions', data),
  updateSession: (id: number, data: { name: string; criteria_id?: number }) =>
    api.put(`/records/sessions/${id}`, data),
  deleteSession: (id: number) => api.delete(`/records/sessions/${id}`),

  importExcel: (sessionId: number, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post(`/records/sessions/${sessionId}/import-excel`, form);
  },
  getStudents: (sessionId: number) => api.get(`/records/sessions/${sessionId}/students`),
  getStudentContent: (studentId: number) => api.get(`/records/students/${studentId}/content`),
  saveStudentContent: (
    studentId: number,
    data: { content_type: string; domain: string; content: string }
  ) => api.put(`/records/students/${studentId}/content`, data),
  exportExcel: (sessionId: number, type: 'comments' | 'scoring') =>
    api.get(`/records/sessions/${sessionId}/export?type=${type}`, { responseType: 'blob' }),
  exportFull: (classId: number) =>
    api.get(`/records/export-full/${classId}`, { responseType: 'blob' }),
  importFull: (classId: number, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post(`/records/import-full/${classId}`, form);
  },
  importFullFile: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post('/records/import-full', form);
  },
  getWrittenExams: (classId: number) => api.get(`/records/classes/${classId}/written-exams`, { params: { t: Date.now() } }),
  saveWrittenScores: (classId: number, items: { student_id: number; domain_name: string; score: string }[]) =>
    api.put(`/records/classes/${classId}/written-scores`, { items }),
  deleteStudentContent: (data: {
    classId: number;
    studentIds?: number[];
    domain?: string;
    contentTypes: string[];
  }) => api.post('/records/delete-content', data),
};

// Artifacts
export const artifactsApi = {
  getOne: (id: number) => api.get(`/artifacts/${id}`),
  getByStudent: (studentId: number) => api.get(`/artifacts/student/${studentId}`),
  getByDomain: (studentId: number, domain: string) =>
    api.get(`/artifacts/student/${studentId}/domain/${encodeURIComponent(domain)}`),
  upload: (studentId: number, domain: string, files: FileList) => {
    const form = new FormData();
    form.append('domain', domain);
    Array.from(files).forEach((f) => form.append('files', f));
    return api.post(`/artifacts/student/${studentId}`, form);
  },
  delete: (id: number) => api.delete(`/artifacts/${id}`),
  fileUrl: (id: number) => `/api/artifacts/${id}/file`,
  viewerUrl: (id: number) => `/artifacts/${id}/view`,
};

export const assignmentConfigsApi = {
  getConfig: (params: { year: number; semester: number; grade: number; subject: string; domainName: string }) =>
    api.get('/assignment-configs/config', { params: { ...params, t: Date.now() } }),
  saveConfig: (data: {
    year: number;
    semester: number;
    grade: number;
    subject: string;
    domainName: string;
    title: string;
    guide_md: string;
    guide_url: string;
    allowed_extensions: string;
    max_file_size_mb: number;
    max_files: number;
  }) => api.put('/assignment-configs/config', data),
  uploadGuideMd: (params: { year: number; semester: number; grade: number; subject: string; domainName: string }, file: File) => {
    const form = new FormData();
    Object.entries(params).forEach(([key, value]) => form.append(key, String(value)));
    form.append('file', file);
    return api.post('/assignment-configs/guide-md', form);
  },
  uploadResources: (params: { year: number; semester: number; grade: number; subject: string; domainName: string }, files: FileList) => {
    const form = new FormData();
    Object.entries(params).forEach(([key, value]) => form.append(key, String(value)));
    Array.from(files).forEach((file) => form.append('files', file));
    return api.post('/assignment-configs/resources', form);
  },
  addResourceLink: (data: { year: number; semester: number; grade: number; subject: string; domainName: string; url: string; title?: string }) =>
    api.post('/assignment-configs/resource-links', data),
  deleteResource: (id: number) => api.delete(`/assignment-configs/resources/${id}`),
  resourceFileUrl: (id: number) => `/api/assignment-configs/resources/${id}/file`,
  getHistory: (params: { year: number; semester: number; grade: number; subject: string; domainName: string }) =>
    api.get('/assignment-configs/history', { params: { ...params, t: Date.now() } }),
  getHistoryDetail: (runId: number, params: { year: number; semester: number; grade: number; subject: string; domainName: string }) =>
    api.get(`/assignment-configs/history/${runId}`, { params: { ...params, t: Date.now() } }),
  getSubmissions: (params: { year: number; semester: number; grade: number; subject: string; domainName: string; room?: string }) =>
    api.get('/assignment-configs/submissions', { params: { ...params, t: Date.now() } }),
  deleteSubmission: (id: number) => api.delete(`/assignment-configs/submissions/${id}`),
  submissionFileUrl: (id: number) => `/api/assignment-configs/submissions/${id}/file`,
};

// Classes (수업 관리)
export const classesApi = {
  getAll: () => api.get('/classes'),
  getOne: (id: number) => api.get(`/classes/${id}`),
  getStudents: (id: number) => api.get(`/classes/${id}/students`),
  getDomains: (id: number) => api.get(`/classes/${id}/domains`),
  uploadScoring: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post('/classes/upload/scoring', form);
  },
  uploadComments: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post('/classes/upload/comments', form);
  },
  uploadWrittenExam: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.post('/classes/upload/written-exam', form);
  },
  delete: (id: number) => api.delete(`/classes/${id}`),
  deleteScoring: (id: number) => api.delete(`/classes/${id}/scoring`),
  deleteComments: (id: number) => api.delete(`/classes/${id}/comments`),
  deleteWrittenExam: (id: number, domainName: string) => api.delete(`/classes/${id}/written-exams/${encodeURIComponent(domainName)}`),
  syncSession: (classId: number, sessionId: number) =>
    api.post(`/classes/${classId}/sync-session/${sessionId}`),
};

// AI
export const aiApi = {
  generate: (data: {
    studentId: number;
    domain: string;
    contentType: 'scoring' | 'comments';
    criteriaSetId: number;
  }) => api.post('/ai/generate', data),
  spellcheck: (data: { text: string }, signal?: AbortSignal) => api.post('/ai/spellcheck', data, { signal }),
  generatePrompt: (data: {
    prompt: string;
    systemPrompt?: string;
    outputSchema?: Record<string, unknown>;
  }, signal?: AbortSignal) =>
    api.post('/ai/generate-prompt', data, { signal }),
  generateClaudeBatch: (data: {
    classId: number;
    domain: string;
    contentType: 'scoring' | 'comments' | 'combined';
    studentIds: number[];
  }) => api.post('/ai/generate-claude-batch', data, { timeout: CLAUDE_BATCH_SUBMIT_TIMEOUT_MS }),
  spellcheckClaudeBatch: (data: {
    classId: number;
    items: Array<{ studentId: number; text: string }>;
  }) => api.post('/ai/spellcheck-claude-batch', data, { timeout: CLAUDE_BATCH_SUBMIT_TIMEOUT_MS }),
  listClaudeBatchJobs: (classId: number) => api.get('/ai/claude-batch-jobs', { params: { classId } }),
  checkClaudeBatchResults: (batchIds: string[]) => api.post('/ai/claude-batch-results', { batchIds }),
};
