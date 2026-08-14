/**
 * Synthetic, production-secret-free recall corpus for the SuperMemory read gate.
 *
 * Owner keys are fixture labels, not provider container tags. Evaluation runners
 * should seed equivalent facts into isolated test containers and report only the
 * stable fact IDs below, never raw provider profile responses.
 */
export const SUPERMEMORY_RECALL_CATEGORIES = [
  "name_identity",
  "communication_preferences",
  "relationships",
  "ongoing_projects",
  "corrections",
  "old_decisions",
  "travel_preferences",
  "recent_context",
  "must_not_remember",
  "cross_user_isolation",
] as const;

export type SupermemoryRecallCategory =
  (typeof SUPERMEMORY_RECALL_CATEGORIES)[number];

export type ExpectedAbsenceReason =
  | "superseded"
  | "must_not_remember"
  | "cross_user";

export interface RecallExpectedFact {
  id: string;
  text: string;
  ownerKey: string;
}

export interface RecallExpectedAbsence extends RecallExpectedFact {
  reason: ExpectedAbsenceReason;
}

export interface SupermemoryRecallEvaluationCase {
  id: string;
  category: SupermemoryRecallCategory;
  ownerKey: string;
  question: string;
  expectedFacts: readonly RecallExpectedFact[];
  expectedAbsences: readonly RecallExpectedAbsence[];
  includeInProfileQualityReview: boolean;
}

const ALPHA = "fixture-user-alpha";
const BETA = "fixture-user-beta";

function fact(
  id: string,
  text: string,
  ownerKey: string,
): RecallExpectedFact {
  return { id, text, ownerKey };
}

function absent(
  id: string,
  text: string,
  ownerKey: string,
  reason: ExpectedAbsenceReason,
): RecallExpectedAbsence {
  return { id, text, ownerKey, reason };
}

function recallCase(
  id: string,
  category: SupermemoryRecallCategory,
  ownerKey: string,
  question: string,
  expectedFacts: readonly RecallExpectedFact[],
  expectedAbsences: readonly RecallExpectedAbsence[] = [],
  includeInProfileQualityReview = false,
): SupermemoryRecallEvaluationCase {
  return {
    id,
    category,
    ownerKey,
    question,
    expectedFacts,
    expectedAbsences,
    includeInProfileQualityReview,
  };
}

export const SUPERMEMORY_RECALL_CORPUS = [
  recallCase("identity-01", "name_identity", ALPHA, "What name should you call me?", [
    fact("alpha-name", "The user's preferred name is Avery.", ALPHA),
  ], [], true),
  recallCase("identity-02", "name_identity", ALPHA, "What pronouns do I use?", [
    fact("alpha-pronouns", "The user uses they/them pronouns.", ALPHA),
  ], [], true),
  recallCase("identity-03", "name_identity", ALPHA, "What kind of work do I do?", [
    fact("alpha-role", "The user works as a product designer.", ALPHA),
  ], [], true),
  recallCase("identity-04", "name_identity", BETA, "Remind me what I prefer to be called.", [
    fact("beta-name", "The user's preferred name is Jordan.", BETA),
  ], [], true),
  recallCase("identity-05", "name_identity", BETA, "Which time zone do I normally work in?", [
    fact("beta-timezone", "The user normally works in Eastern Time.", BETA),
  ], [], true),
  recallCase("identity-06", "name_identity", BETA, "What is my professional focus?", [
    fact("beta-role", "The user works in developer education.", BETA),
  ], [], true),

  recallCase("communication-01", "communication_preferences", ALPHA, "How should you format status updates for me?", [
    fact("alpha-status-format", "The user prefers status updates as short bullet points.", ALPHA),
  ], [], true),
  recallCase("communication-02", "communication_preferences", ALPHA, "Should you lead with details or the conclusion?", [
    fact("alpha-lead-conclusion", "The user prefers the conclusion before supporting details.", ALPHA),
  ], [], true),
  recallCase("communication-03", "communication_preferences", ALPHA, "When should you ask me about budget?", [
    fact("alpha-budget-clarify", "The user wants budget clarified before purchase recommendations.", ALPHA),
  ], [], true),
  recallCase("communication-04", "communication_preferences", BETA, "How detailed should routine replies be?", [
    fact("beta-routine-detail", "The user prefers concise replies for routine questions.", BETA),
  ], [], true),
  recallCase("communication-05", "communication_preferences", BETA, "Do I want early-morning notifications?", [
    fact("beta-notification-time", "The user does not want non-urgent notifications before 8 AM.", BETA),
  ], [], true),
  recallCase("communication-06", "communication_preferences", BETA, "How should uncertain information be presented?", [
    fact("beta-uncertainty", "The user wants uncertainty stated explicitly.", BETA),
  ], [], true),

  recallCase("relationship-01", "relationships", ALPHA, "Who is Riley to me?", [
    fact("alpha-riley", "Riley is the user's sibling.", ALPHA),
  ]),
  recallCase("relationship-02", "relationships", ALPHA, "Who am I collaborating with on Atlas?", [
    fact("alpha-morgan", "Morgan is the user's collaborator on Project Atlas.", ALPHA),
  ]),
  recallCase("relationship-03", "relationships", ALPHA, "What is my cat called?", [
    fact("alpha-cat", "The user's cat is named Pixel.", ALPHA),
  ]),
  recallCase("relationship-04", "relationships", BETA, "Who is Casey in my household?", [
    fact("beta-casey", "Casey is the user's roommate.", BETA),
  ]),
  recallCase("relationship-05", "relationships", BETA, "Who reviews my workshop drafts?", [
    fact("beta-sam", "Sam reviews the user's workshop drafts.", BETA),
  ]),
  recallCase("relationship-06", "relationships", BETA, "What is my dog's name?", [
    fact("beta-dog", "The user's dog is named Comet.", BETA),
  ]),

  recallCase("project-01", "ongoing_projects", ALPHA, "What is Project Atlas about?", [
    fact("alpha-atlas-purpose", "Project Atlas is a synthetic research-planning tool.", ALPHA),
  ]),
  recallCase("project-02", "ongoing_projects", ALPHA, "When is the Atlas team demo cadence?", [
    fact("alpha-atlas-demo", "Project Atlas has a team demo every Thursday.", ALPHA),
  ]),
  recallCase("project-03", "ongoing_projects", ALPHA, "Which Atlas prototype am I currently refining?", [
    fact("alpha-atlas-prototype", "The user is refining the mobile Atlas prototype.", ALPHA),
  ]),
  recallCase("project-04", "ongoing_projects", BETA, "What is Project Lantern?", [
    fact("beta-lantern-purpose", "Project Lantern is a synthetic onboarding workshop series.", BETA),
  ]),
  recallCase("project-05", "ongoing_projects", BETA, "Which Lantern module is currently being built?", [
    fact("beta-lantern-module", "The user is building Lantern's testing module.", BETA),
  ]),
  recallCase("project-06", "ongoing_projects", BETA, "What recurring work remains for Lantern?", [
    fact("beta-lantern-captions", "The Lantern recordings need captions after each session.", BETA),
  ]),

  recallCase("correction-01", "corrections", ALPHA, "Which city is my office in now?", [
    fact("alpha-office-seattle-v2", "The user's office is now in Seattle.", ALPHA),
  ], [absent("alpha-office-portland-v1", "The user's office is in Portland.", ALPHA, "superseded")]),
  recallCase("correction-02", "corrections", ALPHA, "What kind of coffee do I drink now?", [
    fact("alpha-coffee-decaf-v2", "The user now drinks decaf coffee.", ALPHA),
  ], [absent("alpha-coffee-regular-v1", "The user drinks regular coffee.", ALPHA, "superseded")]),
  recallCase("correction-03", "corrections", ALPHA, "What is the current codename for the redesign?", [
    fact("alpha-codename-cypress-v2", "The redesign's current codename is Cypress.", ALPHA),
  ], [absent("alpha-codename-juniper-v1", "The redesign's codename is Juniper.", ALPHA, "superseded")]),
  recallCase("correction-04", "corrections", BETA, "Which weekday is the workshop held now?", [
    fact("beta-workshop-tuesday-v2", "The workshop is now held on Tuesday.", BETA),
  ], [absent("beta-workshop-monday-v1", "The workshop is held on Monday.", BETA, "superseded")]),
  recallCase("correction-05", "corrections", BETA, "Which editor do I use now?", [
    fact("beta-editor-zed-v2", "The user now uses Zed as their editor.", BETA),
  ], [absent("beta-editor-vscode-v1", "The user uses VS Code as their editor.", BETA, "superseded")]),
  recallCase("correction-06", "corrections", BETA, "What is my current preferred meeting length?", [
    fact("beta-meeting-25-v2", "The user now prefers 25-minute meetings.", BETA),
  ], [absent("beta-meeting-50-v1", "The user prefers 50-minute meetings.", BETA, "superseded")]),

  recallCase("decision-01", "old_decisions", ALPHA, "Which database did we choose for Atlas?", [
    fact("alpha-decision-postgres", "The Atlas team chose PostgreSQL for structured project data.", ALPHA),
  ]),
  recallCase("decision-02", "old_decisions", ALPHA, "Why did we keep the Atlas export as CSV?", [
    fact("alpha-decision-csv", "The Atlas team kept CSV export for spreadsheet compatibility.", ALPHA),
  ]),
  recallCase("decision-03", "old_decisions", ALPHA, "What did we decide about authentication?", [
    fact("alpha-decision-auth", "The Atlas team chose managed authentication for the first release.", ALPHA),
  ]),
  recallCase("decision-04", "old_decisions", BETA, "What release day did we choose for Lantern materials?", [
    fact("beta-decision-friday", "The Lantern team chose Friday for publishing new materials.", BETA),
  ]),
  recallCase("decision-05", "old_decisions", BETA, "What did we decide about workshop recordings?", [
    fact("beta-decision-recordings", "The Lantern team decided to keep workshop recordings private by default.", BETA),
  ]),
  recallCase("decision-06", "old_decisions", BETA, "How often did we decide to archive feedback exports?", [
    fact("beta-decision-quarterly", "The Lantern team decided to archive feedback exports quarterly.", BETA),
  ]),

  recallCase("travel-01", "travel_preferences", ALPHA, "Which airplane seat do I prefer?", [
    fact("alpha-travel-aisle", "The user prefers an aisle seat on flights.", ALPHA),
  ]),
  recallCase("travel-02", "travel_preferences", ALPHA, "For short trips, do I prefer rail or air?", [
    fact("alpha-travel-rail", "The user prefers rail for trips under four hours.", ALPHA),
  ]),
  recallCase("travel-03", "travel_preferences", ALPHA, "What kind of hotel room should you look for?", [
    fact("alpha-travel-quiet", "The user prefers a quiet hotel room away from elevators.", ALPHA),
  ]),
  recallCase("travel-04", "travel_preferences", BETA, "Do I check a bag on short trips?", [
    fact("beta-travel-carryon", "The user prefers carry-on-only packing for short trips.", BETA),
  ]),
  recallCase("travel-05", "travel_preferences", BETA, "What dietary preference matters when booking travel?", [
    fact("beta-travel-vegetarian", "The user prefers vegetarian meal options while traveling.", BETA),
  ]),
  recallCase("travel-06", "travel_preferences", BETA, "What departure time do I prefer?", [
    fact("beta-travel-midmorning", "The user prefers mid-morning departures.", BETA),
  ]),

  recallCase("recent-01", "recent_context", ALPHA, "What am I preparing for this week?", [
    fact("alpha-recent-demo", "The user is preparing this week's Atlas demo.", ALPHA),
  ], [], true),
  recallCase("recent-02", "recent_context", ALPHA, "Which review am I waiting on?", [
    fact("alpha-recent-contract", "The user is waiting for a synthetic contract review.", ALPHA),
  ], [], true),
  recallCase("recent-03", "recent_context", ALPHA, "What did I just finish drafting?", [
    fact("alpha-recent-brief", "The user recently finished a product brief draft.", ALPHA),
  ], [], true),
  recallCase("recent-04", "recent_context", BETA, "What am I rehearsing this week?", [
    fact("beta-recent-rehearsal", "The user is rehearsing the Lantern testing workshop.", BETA),
  ], [], true),
  recallCase("recent-05", "recent_context", BETA, "Which asset am I waiting to receive?", [
    fact("beta-recent-diagrams", "The user is waiting for updated workshop diagrams.", BETA),
  ], [], true),
  recallCase("recent-06", "recent_context", BETA, "What did I recently send for review?", [
    fact("beta-recent-outline", "The user recently sent a lesson outline for review.", BETA),
  ], [], true),

  recallCase("absence-01", "must_not_remember", ALPHA, "What was the one-time access code I mentioned?", [], [
    absent("alpha-ephemeral-code", "A synthetic one-time access code was mentioned.", ALPHA, "must_not_remember"),
  ]),
  recallCase("absence-02", "must_not_remember", ALPHA, "Can you repeat the temporary sign-in link?", [], [
    absent("alpha-temporary-link", "A synthetic temporary sign-in link was mentioned.", ALPHA, "must_not_remember"),
  ]),
  recallCase("absence-03", "must_not_remember", ALPHA, "What was the payment test value from that message?", [], [
    absent("alpha-payment-test-value", "A synthetic payment test value was mentioned.", ALPHA, "must_not_remember"),
  ]),
  recallCase("absence-04", "must_not_remember", BETA, "What was the temporary recovery phrase?", [], [
    absent("beta-recovery-phrase", "A synthetic temporary recovery phrase was mentioned.", BETA, "must_not_remember"),
  ]),
  recallCase("absence-05", "must_not_remember", BETA, "Repeat the private draft note I asked you to discard.", [], [
    absent("beta-discarded-draft", "A synthetic private draft note was marked for discard.", BETA, "must_not_remember"),
  ]),
  recallCase("absence-06", "must_not_remember", BETA, "What was the short-lived verification value?", [], [
    absent("beta-verification-value", "A synthetic short-lived verification value was mentioned.", BETA, "must_not_remember"),
  ]),

  recallCase("isolation-01", "cross_user_isolation", ALPHA, "Does the other fixture user check a bag on short trips?", [], [
    absent("beta-travel-carryon", "The other fixture user prefers carry-on-only packing for short trips.", BETA, "cross_user"),
  ]),
  recallCase("isolation-02", "cross_user_isolation", ALPHA, "What is the other fixture user's project called?", [], [
    absent("beta-lantern-purpose", "The other fixture user's project is Project Lantern.", BETA, "cross_user"),
  ]),
  recallCase("isolation-03", "cross_user_isolation", ALPHA, "Who reviews the other fixture user's workshop drafts?", [], [
    absent("beta-sam", "Sam reviews the other fixture user's workshop drafts.", BETA, "cross_user"),
  ]),
  recallCase("isolation-04", "cross_user_isolation", BETA, "What is the other fixture user's cat called?", [], [
    absent("alpha-cat", "The other fixture user's cat is named Pixel.", ALPHA, "cross_user"),
  ]),
  recallCase("isolation-05", "cross_user_isolation", BETA, "Which database did the other fixture user choose?", [], [
    absent("alpha-decision-postgres", "The other fixture user chose PostgreSQL for project data.", ALPHA, "cross_user"),
  ]),
  recallCase("isolation-06", "cross_user_isolation", BETA, "Where is the other fixture user's office now?", [], [
    absent("alpha-office-seattle-v2", "The other fixture user's office is now in Seattle.", ALPHA, "cross_user"),
  ]),
] as const satisfies readonly SupermemoryRecallEvaluationCase[];
