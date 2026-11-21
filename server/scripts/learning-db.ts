import { FileStore, localLearningDir } from "../src/learn/store.ts";
import { SupabaseStore } from "../src/learn/supabase.ts";

const command = process.argv[2];
const url = process.env.SUPABASE_DB_URL;
if (!url || (command !== "migrate" && command !== "import")) {
  console.error("Set SUPABASE_DB_URL and run npm run learning-db -w server -- migrate|import");
  process.exit(1);
}

const store = new SupabaseStore(url);
try {
  if (command === "migrate") {
    await store.migrate();
    console.log("Learning tables are ready.");
  } else {
    const history = new FileStore(localLearningDir).history();
    await store.importHistory(history);
    console.log(`Imported ${history.calls.length} call reviews, ${history.playbooks.length} playbooks, and ${history.runs.length} eval runs. Current playbook is v${history.currentVersion}.`);
  }
} finally {
  await store.close();
}
