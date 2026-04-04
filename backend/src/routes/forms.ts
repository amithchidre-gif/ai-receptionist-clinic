import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { verifyToken } from '../middleware/auth';
import { sendSuccess, sendError } from '../middleware/responseHelpers';
import { createFormToken, validateFormToken, markTokenUsed } from '../services/formTokenService';
import { markFormCompleted } from '../models/appointmentModel';
import { query } from '../config/db';

export { createFormToken };   // re-export so conversationManager can require() this file

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PDF_DIR = path.join(process.cwd(), 'tmp', 'forms');

function ensurePdfDir(): void {
  if (!fs.existsSync(PDF_DIR)) {
    fs.mkdirSync(PDF_DIR, { recursive: true });
  }
}

async function generatePdf(params: {
  appointmentId: string;
  clinicName: string;
  patientName: string;
  patientDob: string;
  patientPhone: string;
  appointmentDate: string;
  appointmentTime: string;
  responses: Record<string, string>;
}): Promise<string> {
  ensurePdfDir();
  const filePath = path.join(PDF_DIR, `${params.appointmentId}.pdf`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Header
    doc
      .fontSize(20)
      .font('Helvetica-Bold')
      .text(params.clinicName, { align: 'center' });
    doc
      .fontSize(14)
      .font('Helvetica')
      .text('Patient Intake Form', { align: 'center' });
    doc.moveDown(1.5);

    // Patient info
    doc.fontSize(12).font('Helvetica-Bold').text('Patient Information');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.4);
    doc.fontSize(11).font('Helvetica');
    doc.text(`Name:           ${params.patientName}`);
    doc.text(`Date of Birth:  ${params.patientDob || 'Not provided'}`);
    doc.text(`Phone:          ${params.patientPhone || 'Not provided'}`);
    doc.moveDown(1);

    // Visit info
    doc.fontSize(12).font('Helvetica-Bold').text('Visit Details');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.4);
    doc.fontSize(11).font('Helvetica');
    doc.text(`Date: ${params.appointmentDate}`);
    doc.text(`Time: ${params.appointmentTime}`);
    doc.moveDown(1);

    // Form responses
    const keys = Object.keys(params.responses);
    if (keys.length > 0) {
      doc.fontSize(12).font('Helvetica-Bold').text('Form Responses');
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.4);
      for (const key of keys) {
        doc.fontSize(11).font('Helvetica-Bold').text(key);
        doc.fontSize(11).font('Helvetica').text(params.responses[key] || '—');
        doc.moveDown(0.6);
      }
    }

    // Footer
    doc.moveDown(2);
    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor('#888888')
      .text(`Submitted on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, { align: 'center' });

    doc.end();
    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// GET /form/:token  — NO auth — patient-facing token validation
// Registered both here (for /api/forms/:token when double-mounted)
// and in server.ts at /form/:token for the canonical patient URL.
// ---------------------------------------------------------------------------

export async function handleFormTokenRequest(req: Request, res: Response): Promise<void> {
  const { token } = req.params;
  const payload = await validateFormToken(token);
  if (!payload) {
    sendError(res, 'This link has expired or is invalid.', 410);
    return;
  }
  sendSuccess(res, payload);
}

router.get('/token/:token', handleFormTokenRequest);

// ---------------------------------------------------------------------------
// POST /submit  — NO auth — patient submits form
// ---------------------------------------------------------------------------

router.post('/submit', async (req: Request, res: Response): Promise<void> => {
  const { token, responses } = req.body as { token: unknown; responses: unknown };

  if (!token || typeof token !== 'string') {
    sendError(res, 'Missing token.', 400);
    return;
  }
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) {
    sendError(res, 'responses must be an object.', 400);
    return;
  }

  const payload = await validateFormToken(token);
  if (!payload) {
    sendError(res, 'This link has expired or is invalid.', 410);
    return;
  }

  const { clinicId, appointmentId, patientId } = payload;

  try {
    // Fetch patient phone for the PDF (phone not included in FormTokenPayload)
    const patientRes = await query(
      `SELECT phone FROM patients WHERE id = $1 AND clinic_id = $2`,
      [patientId, clinicId],
    );
    const patientPhone: string = (patientRes.rows[0]?.phone as string) ?? '';

    // 1. Persist form response
    await query(
      `INSERT INTO form_responses (clinic_id, appointment_id, patient_id, response_data)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [clinicId, appointmentId, patientId, JSON.stringify(responses)],
    );

    // 2. Mark token used
    await markTokenUsed(token);

    // 3. Mark appointment form_completed
    await markFormCompleted(appointmentId, clinicId);

    // 4. Generate PDF (non-fatal — never block submission)
    try {
      await generatePdf({
        appointmentId,
        clinicName:      payload.clinicName,
        patientName:     payload.patientName,
        patientDob:      payload.patientDob,
        patientPhone,
        appointmentDate: payload.appointmentDate,
        appointmentTime: payload.appointmentTime,
        responses:       responses as Record<string, string>,
      });
    } catch (pdfErr: unknown) {
      console.error(JSON.stringify({
        level: 'error',
        service: 'formsRoute',
        message: 'PDF generation failed — submission still saved',
        appointmentId,
        error: (pdfErr as Error).message,
        timestamp: new Date().toISOString(),
      }));
    }

    sendSuccess(res, null);
  } catch (err: unknown) {
    console.error(JSON.stringify({
      level: 'error',
      service: 'formsRoute',
      message: 'Form submission failed',
      appointmentId,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
    sendError(res, 'Form submission failed. Please try again.', 500);
  }
});

// ---------------------------------------------------------------------------
// GET /  — auth required — list form responses for this clinic
// ---------------------------------------------------------------------------

router.get('/', verifyToken, async (req: Request, res: Response): Promise<void> => {
  const { clinicId } = req.user!;
  try {
    const result = await query(
      `SELECT fr.id, fr.appointment_id, fr.patient_id, fr.submitted_at,
              fr.response_data, fr.pdf_path,
              p.name AS patient_name,
              a.appointment_date
       FROM form_responses fr
       JOIN patients     p ON p.id = fr.patient_id
       JOIN appointments a ON a.id = fr.appointment_id
       WHERE fr.clinic_id = $1
       ORDER BY fr.submitted_at DESC`,
      [clinicId],
    );
    sendSuccess(res, result.rows);
  } catch (err: unknown) {
    console.error(JSON.stringify({
      level: 'error',
      service: 'formsRoute',
      message: 'Failed to list form responses',
      clinicId,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
    sendError(res, 'Failed to retrieve forms.', 500);
  }
});

// ---------------------------------------------------------------------------
// GET /:appointmentId/pdf  — auth required — stream PDF
// ---------------------------------------------------------------------------

router.get('/:appointmentId/pdf', verifyToken, async (req: Request, res: Response): Promise<void> => {
  const { clinicId } = req.user!;
  const { appointmentId } = req.params;

  // Verify appointment belongs to this clinic
  const apptRes = await query(
    `SELECT id FROM appointments WHERE id = $1 AND clinic_id = $2`,
    [appointmentId, clinicId],
  );
  if (apptRes.rows.length === 0) {
    sendError(res, 'Appointment not found.', 404);
    return;
  }

  const filePath = path.join(PDF_DIR, `${appointmentId}.pdf`);
  if (!fs.existsSync(filePath)) {
    sendError(res, 'PDF not found. The patient may not have submitted their form yet.', 404);
    return;
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${appointmentId}.pdf"`);
  fs.createReadStream(filePath).pipe(res);
});

export default router;
