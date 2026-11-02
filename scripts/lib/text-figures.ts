// Figures in the Legislative Analyst's analyses that are only words and tables, transcribed from
// the published images. Text can be searched, read aloud and resized, and it stays where the
// figure was. Keyed by the mirrored image, which stays in the guide. Every figure in the state
// guide is here: the rule is "it's text", not which measure it's on.

import type { Block, Inline } from "./guide-common";

const heading = (text: string): Block => ({ type: "h", level: 3, text: [text] });
const paragraph = (text: string): Block => ({ type: "p", text: [text] });
const list = (items: string[]): Block => ({
  type: "ul",
  items: items.map((item) => [paragraph(item)]),
});
const cells = (...texts: string[]) => texts.map((text) => ({ text: [text] as Inline[] }));
const heads = (...texts: string[]) => texts.map((text) => ({ header: true, text: [text] }));
const bold = (...texts: string[]) => texts.map((text) => ({ text: [{ strong: [text] }] }));

const interactions = (text: string): Block[] => [
  heading("Potential Interactions With Other Propositions"),
  paragraph(text),
];

export const TEXT_FIGURES: Record<string, Block[]> = {
  "img/prop-1/prop-1-state-bond-cost-estimate.jpg": [
    heading("State Bond Cost Estimate"),
    {
      type: "table",
      rows: [
        cells("Authorized new borrowing", "$11.25 billion"),
        cells("Annual cost to pay off bond", "$500 million to $600 millionᵃ"),
        cells("Likely repayment period", "25 years"),
        cells("Source of repayment", "General tax revenue"),
      ],
    },
    paragraph(
      "ᵃ Proposition 1 includes $1.25 billion for a veterans housing program. This borrowing would not result in estimated state cost.",
    ),
  ],
  "img/prop-1/prop-1-fig-1.jpg": [
    heading("Figure 1. Proposed Uses of Bond Funds (In Millions)"),
    {
      type: "table",
      rows: [
        heads("Category of Programs", "Amount"),
        [...bold("State Housing Programs"), ...cells("")],
        cells("Affordable multifamily housing", "$7,200ᵃ"),
        cells("Homeownership", "1,100"),
        cells("Infrastructure", "500"),
        cells("Farmworker housing", "450"),
        cells("Higher education student housing", "350"),
        cells("Tribal housing", "200"),
        cells("Local pilot programs", "200"),
        cells("Subtotal", "($10,000)"),
        [...bold("Veterans Housing Program"), ...cells("")],
        cells("Veterans home loans", "$1,250"),
        bold("Total", "$11,250"),
      ],
    },
    paragraph("ᵃ Includes $150 million for youth housing."),
  ],
  "img/prop-3/fig1-prop3.jpg": [
    heading("Figure 1. Personal Income Tax Rates Under Proposition 3"),
    {
      type: "table",
      caption: "Marginal tax rate. “Approved” and “Rejected” are after 2030, if this proposal is…",
      rows: [
        heads(
          "Single Filer’s Income",
          "Joint Filers’ Income",
          "Now Through 2030",
          "Approved",
          "Rejected",
        ),
        cells("$0 to $11k", "$0 to $22k", "1.0%", "1.0%", "1.0%"),
        cells("$11k to $26k", "$22k to $53k", "2.0", "2.0", "2.0"),
        cells("$26k to $41k", "$53k to $83k", "4.0", "4.0", "4.0"),
        cells("$41k to $58k", "$83k to $115k", "6.0", "6.0", "6.0"),
        cells("$58k to $73k", "$115k to $145k", "8.0", "8.0", "8.0"),
        cells("$73k to $371k", "$145k to $743k", "9.3", "9.3", "9.3"),
        bold("$371k to $446k", "$743k to $892k", "10.3%", "10.3%", "9.3%"),
        bold("$446k to $743k", "$892k to $1.5 million", "11.3%", "11.3%", "9.3%"),
        bold("Above $743k", "Above $1.5 million", "12.3%", "12.3%", "9.3%"),
      ],
    },
  ],
  "img/prop-38/prop-38-state-bond-cost-estimate.jpg": [
    heading("State Bond Cost Estimate"),
    {
      type: "table",
      rows: [
        cells("Amount Borrowed", "$8.4 billion"),
        cells(
          "Average annual repayment cost",
          "$500 million to $600 million annually for about 20 years",
        ),
        cells(
          "Source of repayment",
          "General tax revenue and possible revenue from discoveries funded by the bond",
        ),
      ],
    },
  ],
  "img/prop-40/prop-40-fig-1.jpg": interactions(
    "If Proposition 41 or 42 on this same ballot receive more “yes” votes than Proposition 40, then Proposition 40 could be stopped from becoming law even if it gets yes votes from a majority of voters. This is because the courts could find that Proposition 41 or 42 conflict with Proposition 40.",
  ),
  "img/prop-41/prop-41-fig-1.jpg": interactions(
    "If Proposition 41 receives more “yes” votes than Proposition 40 on this same ballot, then Proposition 40 could be stopped from becoming law even if it gets yes votes from a majority of voters. This is because the courts could find that Proposition 41 conflicts with Proposition 40.",
  ),
  "img/prop-42/prop-42-fig-1.jpg": interactions(
    "If Proposition 42 receives more “yes” votes than Proposition 40 on this same ballot, then Proposition 40 could be stopped from becoming law even if it gets yes votes from a majority of voters. This is because the courts could find that Proposition 42 conflicts with Proposition 40.",
  ),
  "img/prop-45/prop-45-fig-1.jpg": [
    heading("Figure 1. Types of Projects Eligible to Use Proposition 45’s New Procedures"),
    list([
      "Housing.",
      "Water system (not including Delta conveyance facilities).",
      "Clean energy (not including nuclear power).",
      "Health facility, clinic, and medical office building.",
      "Fire, police, and sheriff’s stations.",
      "Wildfire risk reduction.",
      "Broadband Internet access.",
      "Education facility.",
      "Transportation (not including high-speed rail).",
    ]),
  ],
};
