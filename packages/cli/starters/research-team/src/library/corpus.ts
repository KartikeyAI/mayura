import type { SourceDocument } from './index.js';

// The bundled source library: six short documents about one fictional community solar microgrid. Harlow Creek, its
// co-operative and every figure below are invented for this starter; they are plausible, not facts to cite.
// Replace this corpus (or the whole SourceLibrary) with your own sources; see README "Make it yours".

export const harlowCreekCorpus: readonly SourceDocument[] = [
  {
    id: 'hc-overview',
    title: 'Harlow Creek Community Microgrid: project overview',
    published: '2024-02-12',
    text: `The Harlow Creek Community Microgrid serves 410 households and 23 small businesses in a river valley town of about 1,300 people.
It combines 1.2 MW of rooftop and carport solar on 64 buildings with a 3 MWh lithium iron phosphate battery at the old fire station.
The system was commissioned in September 2022 after four years of planning led by residents who had lived through repeated winter outages.
It stays connected to the regional utility grid in normal operation and can island, running on its own, when the grid fails.
The Harlow Creek Energy Co-operative owns and operates the microgrid; members buy one share each and elect the board.
In its first full year the solar array produced 1,540 MWh, about 38 percent of the electricity used by connected members.
Critical loads such as the clinic, the water pumping station and the school shelter are prioritised whenever the microgrid islands.`,
  },
  {
    id: 'hc-finance',
    title: 'How Harlow Creek paid for its microgrid',
    published: '2024-03-04',
    text: `The microgrid cost 4.8 million dollars to build, including solar, the battery, controls, interconnection and three years of spare parts.
A state resilience grant covered 35 percent of the cost, about 1.7 million dollars, on condition that critical loads were served during outages.
Members bought 1.1 million dollars of co-operative shares, with a sliding price so that low-income households could join for 50 dollars.
The remaining 2.0 million dollars came from a 20-year community green bond sold mostly to residents and the local credit union.
Operating costs, including insurance, maintenance and bond interest, are about 310,000 dollars a year.
Members saw average electricity bill savings of 11 percent in the first year compared with the utility's standard tariff.
The co-operative expects to repay the green bond early if battery degradation stays within the manufacturer's forecast.`,
  },
  {
    id: 'hc-storage',
    title: 'Battery storage and islanding at Harlow Creek',
    published: '2024-05-20',
    text: `The 3 MWh battery uses lithium iron phosphate cells, chosen for thermal stability and a lower fire risk than other lithium chemistries.
During the February 2023 ice storm the regional grid failed for 31 hours; the microgrid islanded within two seconds and the batteries performed as designed.
While islanded it kept the clinic, the water pumping station, the school shelter and 180 homes powered for the whole outage.
The controller shed non-critical loads in stages as the battery state of charge fell below 40 percent, and solar recharged it by day.
Operators reported that winter performance depends heavily on snow clearing, because covered panels produced almost nothing for a day.
Battery capacity has degraded by about 2 percent a year, in line with the warranty, and the cells are monitored remotely every minute.`,
  },
  {
    id: 'hc-governance',
    title: 'Governance and ownership of the Harlow Creek Energy Co-operative',
    published: '2023-11-08',
    text: `The Harlow Creek Energy Co-operative owns and governs the microgrid on behalf of its members; each member owns one share and has one vote.
A nine-person board is elected for staggered three-year terms, and two seats are reserved for renters so that non-owners are represented.
Tariff changes need approval by a majority of members at the annual meeting, which drew 37 percent of members in 2023.
The board contracts daily operations to a regional energy services firm but keeps control of dispatch priorities and outage plans.
Surpluses are split between bill credits for members, a reserve for battery replacement and a small fund for energy efficiency upgrades.
Critics at the 2023 meeting argued that the governance model makes fast decisions hard, for example when negotiating with the utility.`,
  },
  {
    id: 'hc-interconnection',
    title: 'Interconnection and regulation: working with the utility',
    published: '2023-07-15',
    text: `Connecting the microgrid to the regional utility took 14 months of interconnection studies, longer than the construction itself.
The utility required protection equipment so that the microgrid disconnects cleanly and never sends power into a grid under repair.
Exports to the grid are capped at 800 kW, so on sunny spring days the controller curtails solar output or charges the battery instead.
Members are billed under a community net metering tariff approved by the state regulator in 2021 after the co-operative petitioned for it.
The utility still owns the poles and wires; the co-operative pays a monthly wheeling charge to use them inside the town.
State regulators have since cited Harlow Creek as a model, but rule changes in 2025 could reduce the value of exported energy.`,
  },
  {
    id: 'hc-lessons',
    title: 'Lessons learned and open risks after two years of operation',
    published: '2024-09-30',
    text: `In the first year an inverter firmware bug caused three unplanned shutdowns before the manufacturer issued a fix.
Insurance premiums rose 40 percent at renewal after insurers reassessed battery fire risk across the region.
Maintenance costs were higher than planned because rooftop arrays are spread across 64 buildings with different owners and roof ages.
Community engagement mattered most: door-to-door visits signed up more members than any mailing or online campaign.
The largest open risk is replacing the battery around 2035, which the reserve fund is not yet large enough to cover.
Organisers advise other towns to budget for interconnection delays and to agree outage priorities before construction starts.`,
  },
];
