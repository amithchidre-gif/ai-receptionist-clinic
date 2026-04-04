-- Patients
INSERT INTO patients (clinic_id, name, phone, date_of_birth) 
VALUES ('bbb44629-da9b-480a-91a2-6cff9c8c891c', 'John Doe', '+19255551234', '1985-03-15')
ON CONFLICT DO NOTHING;

INSERT INTO patients (clinic_id, name, phone, date_of_birth) 
VALUES ('bbb44629-da9b-480a-91a2-6cff9c8c891c', 'Jane Smith', '+19255554321', '1990-07-22')
ON CONFLICT DO NOTHING;

-- Get patient IDs via a temporary table approach (or use existing IDs)
DO \$\$
DECLARE
    patient1_id UUID;
    patient2_id UUID;
    today_date TEXT := TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD');
    tomorrow_date TEXT := TO_CHAR(CURRENT_DATE + INTERVAL '1 day', 'YYYY-MM-DD');
    last_week_date TEXT := TO_CHAR(CURRENT_DATE - INTERVAL '5 days', 'YYYY-MM-DD');
BEGIN
    -- Get patient IDs
    SELECT id INTO patient1_id FROM patients WHERE clinic_id = 'bbb44629-da9b-480a-91a2-6cff9c8c891c' AND name = 'John Doe' LIMIT 1;
    SELECT id INTO patient2_id FROM patients WHERE clinic_id = 'bbb44629-da9b-480a-91a2-6cff9c8c891c' AND name = 'Jane Smith' LIMIT 1;
    
    -- Create appointments
    INSERT INTO appointments (clinic_id, patient_id, appointment_date, appointment_time, status) 
    VALUES ('bbb44629-da9b-480a-91a2-6cff9c8c891c', patient1_id, today_date, '09:00', 'scheduled');
    
    INSERT INTO appointments (clinic_id, patient_id, appointment_date, appointment_time, status) 
    VALUES ('bbb44629-da9b-480a-91a2-6cff9c8c891c', patient2_id, today_date, '14:00', 'scheduled');
    
    INSERT INTO appointments (clinic_id, patient_id, appointment_date, appointment_time, status) 
    VALUES ('bbb44629-da9b-480a-91a2-6cff9c8c891c', patient1_id, tomorrow_date, '10:00', 'scheduled');
    
    INSERT INTO appointments (clinic_id, patient_id, appointment_date, appointment_time, status) 
    VALUES ('bbb44629-da9b-480a-91a2-6cff9c8c891c', patient1_id, last_week_date, '11:00', 'completed');
    
    -- Create call logs
    INSERT INTO call_logs (clinic_id, session_id, from_number, to_number, status, started_at, duration_seconds) 
    VALUES ('bbb44629-da9b-480a-91a2-6cff9c8c891c', 'test-session-1', '+19255551234', '+19257097010', 'completed', NOW(), 120);
    
    INSERT INTO call_logs (clinic_id, session_id, from_number, to_number, status, started_at, duration_seconds) 
    VALUES ('bbb44629-da9b-480a-91a2-6cff9c8c891c', 'test-session-2', '+19255554321', '+19257097010', 'completed', NOW() - INTERVAL '2 hours', 85);
    
    RAISE NOTICE 'Test data created successfully';
END \$\$;
