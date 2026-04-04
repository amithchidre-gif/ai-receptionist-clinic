-- Create appointments and call logs for dashboard testing
DO \$\$
DECLARE
    p1_id UUID;
    p2_id UUID;
BEGIN
    -- Get existing patient IDs
    SELECT id INTO p1_id FROM patients WHERE clinic_id = 'bbb44629-da9b-480a-91a2-6cff9c8c891c' AND name = 'John Doe' LIMIT 1;
    SELECT id INTO p2_id FROM patients WHERE clinic_id = 'bbb44629-da9b-480a-91a2-6cff9c8c891c' AND name = 'Jane Smith' LIMIT 1;
    
    -- Create appointments for today
    INSERT INTO appointments (clinic_id, patient_id, appointment_date, appointment_time, status) 
    VALUES ('bbb44629-da9b-480a-91a2-6cff9c8c891c', p1_id, TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), '09:00', 'scheduled');
    
    INSERT INTO appointments (clinic_id, patient_id, appointment_date, appointment_time, status) 
    VALUES ('bbb44629-da9b-480a-91a2-6cff9c8c891c', p2_id, TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), '14:00', 'scheduled');
    
    -- Create appointment for tomorrow
    INSERT INTO appointments (clinic_id, patient_id, appointment_date, appointment_time, status) 
    VALUES ('bbb44629-da9b-480a-91a2-6cff9c8c891c', p1_id, TO_CHAR(CURRENT_DATE + INTERVAL '1 day', 'YYYY-MM-DD'), '10:00', 'scheduled');
    
    -- Create call logs
    INSERT INTO call_logs (clinic_id, session_id, from_number, to_number, status, started_at, duration_seconds) 
    VALUES ('bbb44629-da9b-480a-91a2-6cff9c8c891c', 'test-session-1', '+19255551234', '+19257097010', 'completed', NOW(), 120);
    
    INSERT INTO call_logs (clinic_id, session_id, from_number, to_number, status, started_at, duration_seconds) 
    VALUES ('bbb44629-da9b-480a-91a2-6cff9c8c891c', 'test-session-2', '+19255554321', '+19257097010', 'completed', NOW() - INTERVAL '2 hours', 85);
    
    RAISE NOTICE 'Test data created successfully';
END \$\$;
