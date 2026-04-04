export const EMERGENCY_RESPONSE = "This sounds like a medical emergency. Please call 911 or go to your nearest emergency room immediately. Do not wait. Goodbye.";

export function detectEmergency(transcript: string): boolean {
  const lowerTranscript = transcript.toLowerCase();
  const emergencyPhrases = [
    "chest pain",
    "heart attack",
    "can't breathe",
    "cannot breathe",
    "difficulty breathing",
    "trouble breathing",
    "shortness of breath",
    "severe bleeding",
    "bleeding badly",
    "bleeding a lot",
    "won't stop bleeding",
    "stroke",
    "face drooping",
    "arm weakness",
    "sudden numbness",
    "sudden confusion",
    "unconscious",
    "passed out",
    "not breathing",
    "not responding",
    "unresponsive",
    "choking",
    "suicide",
    "kill myself",
    "want to die",
    "end my life",
    "overdose",
    "took too many pills"
  ];

  return emergencyPhrases.some(phrase => lowerTranscript.includes(phrase));
}

if (require.main === module) {
  console.assert(detectEmergency("I have chest pain") === true, "Test 1 failed");
  console.assert(detectEmergency("I want to book an appointment") === false, "Test 2 failed");
  console.assert(detectEmergency("she is having trouble breathing") === true, "Test 3 failed");
  console.assert(detectEmergency("he's unconscious") === true, "Test 4 failed");
  console.assert(detectEmergency("") === false, "Test 5 failed");
  console.assert(detectEmergency("I'm calling about my prescription") === false, "Test 6 failed");
  console.assert(detectEmergency("I think I had a stroke") === true, "Test 7 failed");
  console.assert(detectEmergency("CHEST PAIN SINCE THIS MORNING") === true, "Test 8 failed");
  console.log("All tests passed!");
}