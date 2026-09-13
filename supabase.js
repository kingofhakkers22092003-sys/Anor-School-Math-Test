const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !secretKey) throw new Error('SUPABASE_URL va SUPABASE_SECRET_KEY environment variablelari sozlanmagan.');

const supabase = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
const throwOnError = error => { if (error) throw new Error(`Supabase xatosi: ${error.message}`); };
const studentFromRow = row => ({ id: row.id, fullName: row.full_name, schoolClass: row.school_class, password: row.password, results: row.results || {}, attempts: row.attempts || [], pendingReview: row.pending_review || {}, telegramSent: row.telegram_sent || false, telegramError: row.telegram_error || null });
const studentToRow = student => ({ id: student.id, full_name: student.fullName, school_class: student.schoolClass, password: student.password, results: student.results || {}, attempts: student.attempts || [], pending_review: student.pendingReview || {}, telegram_sent: Boolean(student.telegramSent), telegram_error: student.telegramError || null });

async function getStudents() { const { data, error } = await supabase.from('math_students').select('*').order('created_at'); throwOnError(error); return data.map(studentFromRow); }
async function getStudent(id) { const { data, error } = await supabase.from('math_students').select('*').eq('id', id).maybeSingle(); throwOnError(error); return data ? studentFromRow(data) : null; }
async function saveStudent(student) { const { error } = await supabase.from('math_students').upsert(studentToRow(student)); throwOnError(error); }
async function getQuestionBank(testKeys) { const { data, error } = await supabase.from('math_questions').select('*').order('created_at'); throwOnError(error); const bank = Object.fromEntries(testKeys.map(key => [key, []])); data.forEach(row => { if (bank[row.section]) bank[row.section].push({ id: row.id, grade: row.grade, prompt: row.prompt, ...(row.options ? { options: row.options } : {}), ...(row.answer !== null && row.answer !== undefined ? { answer: row.answer } : {}) }); }); return bank; }
async function addQuestion(question, section) { const { error } = await supabase.from('math_questions').upsert({ id: question.id, section, grade: question.grade ?? null, prompt: question.prompt, options: question.options || null, answer: question.answer ?? null }); throwOnError(error); }
async function updateQuestionGrade(id, grade) { const { error } = await supabase.from('math_questions').update({ grade }).eq('id', id); throwOnError(error); }
async function removeQuestion(id) { const { error } = await supabase.from('math_questions').delete().eq('id', id); throwOnError(error); }
async function getSettings(fallback) { const { data, error } = await supabase.from('math_app_settings').select('value').eq('key', 'main').maybeSingle(); throwOnError(error); return { ...fallback, ...(data?.value || {}) }; }
async function saveSettings(value) { const { error } = await supabase.from('math_app_settings').upsert({ key: 'main', value }); throwOnError(error); }

module.exports = { getStudents, getStudent, saveStudent, getQuestionBank, addQuestion, updateQuestionGrade, removeQuestion, getSettings, saveSettings };
