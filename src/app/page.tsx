import { redirect } from "next/navigation";

// CHE-108: Home — point visitors at a real verdict so they can see
// what a check produces without handing over their own URL.
export default function Home() {
  redirect("/verdict/demo-verdict");
}
