import { expect } from 'chai'

import { BlockedError } from '../../../core/result'
import { defineHarness } from '../../../core/spec'
import {
  at,
  dismissNotificationAsk,
  type EventWeb,
  openEventWeb
} from '../../../rigs/eventWeb'

/**
 * The team schedule's RSVP controls and the event page they lead to, in a
 * phone-sized browser: only upcoming games take replies, the badge and
 * count sizes and edges, family avatars that persist, the compact
 * attendance, the hero's two lines, the reply card's lines, the team pill
 * and RSVP capsules that keep a straying finger; and the general
 * schedule's date column. The `event-schedule` world's owner runs the
 * Hawks, belongs to the Eagles, and is guardian of Trout and Ichiro.
 */

const PHONE = { width: 390, height: 844 }

const pillId = (userId: string): string => `event-rsvp-${userId}`

/** Brings the element into the middle of the screen, then taps it. */
async function tap(web: EventWeb, id: string): Promise<void> {
  await web.m.evalBrowserScript({
    script: `document.querySelector('[data-testid="${id}"]').scrollIntoView({block:'center'})`
  })
  await web.m.tapOn({ id })
}

export default defineHarness({
  id: 'scoring/event-info/schedule-rsvps',
  title: "The team schedule's RSVP controls and the replies they lead to",
  kind: 'e2e',
  covers: [
    'src/app/screens/ScheduleRsvpControl.tsx',
    'src/app/screens/EventRsvpModal.tsx',
    'src/app/screens/EventInfoTab.tsx',
    'src/app/components/RsvpScheduleRow.tsx',
    'src/app/components/ScheduleRow.tsx'
  ],
  stack: 'isolated',
  fixtures: ['event-schedule'],
  exclusive: false,
  surfaces: {
    // No 3D: headless Chromium on a browser droplet.
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 8,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'rsvp-controls': async ctx => {
      const w = await ctx.fixture('event-schedule')
      const id = (role: string): string => w.accounts[role].userId
      const upcoming = w.ids.upcoming
      const web = await openEventWeb(ctx, w.accounts.owner, PHONE)
      const { m, evaluate, wait } = web
      await web.go(`/teams/${w.ids.teamA}?tab=schedule`)
      await wait(
        `document.querySelector('[data-testid="schedule-rsvp-control-${upcoming}"]')!=null`
      )
      expect(
        await evaluate<boolean>(
          `${JSON.stringify([w.ids.past, w.ids.final, w.ids.cancelled, w.ids.live])}.every(id=>document.querySelector('[data-testid="schedule-rsvp-control-'+id+'"]')==null)`
        )
      ).to.equal(true)
      const sizes = await evaluate<{ button: number; count: number }>(
        `(()=>{const footer=document.querySelector('[data-testid="schedule-rsvps-${upcoming}"]');return{button:footer.querySelector('[data-testid="schedule-rsvp-button"]').getBoundingClientRect().height,count:footer.querySelector('[data-testid="player-rsvp-count-unknown"]').getBoundingClientRect().height}})()`
      )
      expect(Math.abs(sizes.button - sizes.count)).to.be.below(2)
      expect(sizes.button).to.equal(32)
      const layout = await evaluate<{
        aligned: boolean
        calendars: boolean
      }>(`(()=>{
        const footer=document.querySelector('[data-testid="schedule-rsvps-${upcoming}"]'), card=footer.closest('[data-testid="schedule-row"]');
        const control=footer.querySelector('[role="button"]'), details=card.querySelector('[data-testid="schedule-details"]');
        return {aligned:Math.abs(control.getBoundingClientRect().left-details.getBoundingClientRect().left)<1,
          calendars:Array.from(document.querySelectorAll('[data-testid="schedule-date"]')).every(node=>{
            const weekday=node.querySelector('[data-testid="schedule-weekday"]'),separator=node.querySelector('[data-testid="schedule-date-separator"]');
            const date=node.getBoundingClientRect(), row=node.closest('[data-testid="schedule-row"]'), body=row?.querySelector('[data-testid="schedule-body"]');
            if (body && Math.abs((body.getBoundingClientRect().left-date.right)-parseFloat(getComputedStyle(row.parentElement).paddingLeft))>1) return false;
            if (row && !row.querySelector('[data-testid^="schedule-rsvps-"]')) {
              const time=row.querySelector('[data-testid="schedule-time"]');
              return !weekday && !separator && /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) /.test(time.textContent) && getComputedStyle(time).fontWeight==='700';
            }
            return weekday && separator && weekday.getBoundingClientRect().bottom<=separator.getBoundingClientRect().top && separator.getBoundingClientRect().height===3 &&
              getComputedStyle(separator).marginTop==='8px' && getComputedStyle(separator).marginBottom==='8px' &&
              getComputedStyle(weekday).fontSize==='15px' && getComputedStyle(node.querySelectorAll('[dir="auto"]')[1]).fontSize==='20px' &&
              getComputedStyle(node.lastElementChild).fontSize==='32px';
          })};
      })()`)
      expect(layout.aligned && layout.calendars).to.equal(true)
      expect(
        await evaluate<boolean>(`${JSON.stringify([upcoming, w.ids.noVenue])}.every(id=>{
          const footer=document.querySelector('[data-testid="schedule-rsvps-'+id+'"]'),row=footer.closest('[data-testid="schedule-row"]');
          return Math.abs(footer.getBoundingClientRect().bottom-row.getBoundingClientRect().bottom)<1;
        })`)
      ).to.equal(true)
      expect(
        await evaluate<boolean>(`(()=>{
          const footer=document.querySelector('[data-testid="schedule-rsvps-${upcoming}"]');
          const row=footer.closest('[data-testid="schedule-row"]'), date=row.querySelector('[data-testid="schedule-date"]');
          const details=row.querySelector('[data-testid="schedule-details"]').getBoundingClientRect(), needed=Math.max(date.getBoundingClientRect().height, footer.getBoundingClientRect().bottom-details.top);
          return Math.abs(row.getBoundingClientRect().height-needed)<2;
        })()`)
      ).to.equal(true)
      // A card's badge and its RSVP count bubbles end at the same right edge.
      const edges = await evaluate<Array<{ badge: number; counts: number }>>(
        `Array.from(document.querySelectorAll('[data-testid="schedule-row"]')).flatMap(row=>{
          const counts=row.querySelector('[data-testid="player-rsvp-counts"]'), label=Array.from(row.querySelectorAll('div')).find(node=>node.childElementCount===0&&/^(LIVE|Canceled|Pending approval|[WLT] \\d)/.test(node.textContent));
          return counts&&label&&counts.childElementCount>0?[{badge:label.parentElement.getBoundingClientRect().right,counts:counts.getBoundingClientRect().right}]:[];
        })`
      )
      expect(
        edges.length,
        'A card has both a badge and RSVP counts'
      ).to.be.above(0)
      expect(
        edges.every(edge => Math.abs(edge.badge - edge.counts) < 1.5),
        `Badges end where the RSVP counts do: ${JSON.stringify(edges)}`
      ).to.equal(true)
      await tap(web, `schedule-rsvp-control-${upcoming}`)
      await wait(
        `document.querySelector('[data-testid="${pillId(id('ichiro'))}-2"]')!=null`
      )
      for (const [role, choice] of [
        ['owner', 0],
        ['trout', 2],
        ['ichiro', 0]
      ] as const) {
        await tap(web, `${pillId(id(role))}-${choice}`)
        await wait(
          `document.querySelector('[data-testid="${pillId(id(role))}-${choice}"]').getAttribute('aria-disabled')!=='true'`
        )
      }
      await tap(web, `${pillId(id('ichiro'))}-1`)
      await wait(
        `document.querySelector('[data-testid="${pillId(id('ichiro'))}-1"]').getAttribute('aria-disabled')!=='true'`
      )
      await m.tapOn({ text: 'Done' })
      // An RSVP asks about notifications once per person per device.
      await dismissNotificationAsk(m)
      await wait(
        `document.querySelectorAll('[data-testid^="schedule-rsvp-avatar-"]').length===3`
      )
      const colors = await evaluate<string[]>(
        `${JSON.stringify(['owner', 'trout', 'ichiro'].map(id))}.map(id=>getComputedStyle(document.querySelector('[data-testid="schedule-rsvp-avatar-'+id+'"]')).borderColor)`
      )
      expect(
        await evaluate<boolean>(`(()=>{
          const footer=document.querySelector('[data-testid="schedule-rsvps-${upcoming}"]');
          const avatars=Array.from(footer.querySelectorAll('[data-testid^="schedule-rsvp-avatar-"]'));
          const pills=Array.from(footer.querySelectorAll('[data-testid^="player-rsvp-count-"]'));
          return [...avatars,...pills].every(node=>node.getBoundingClientRect().height===32);
        })()`)
      ).to.equal(true)
      expect(colors).to.deep.equal([
        'rgb(32, 138, 75)',
        'rgb(203, 57, 65)',
        'rgb(35, 118, 207)'
      ])
      await web.shot('schedule-avatars.png')
      await tap(web, `schedule-rsvp-control-${upcoming}`)
      await wait(
        `document.querySelector('[data-testid="${pillId(id('trout'))}-2"]')?.getAttribute('aria-checked')==='true'`
      )
      await m.tapOn({ text: 'Done' })
      await web.go(`/teams/${w.ids.teamA}?tab=schedule`)
      await wait(
        `document.querySelectorAll('[data-testid^="schedule-rsvp-avatar-"]').length===3`
      )
      await m.evalBrowserScript({
        script: `document.querySelector('[data-testid="schedule-rsvps-${upcoming}"]').closest('[data-testid="schedule-row"]').querySelector('[data-testid="schedule-date"]').scrollIntoView({block:'center'})`
      })
      await m.tapOn({
        css: `[data-testid="schedule-row"]:has([data-testid="schedule-rsvps-${upcoming}"]) [data-testid="schedule-date"]`
      })
      await wait(
        `document.querySelector('[data-testid="event-attendance-teams"]')!=null`
      )
      expect(
        await evaluate<boolean>(`(()=>{
          const cards=Array.from(document.querySelectorAll('[data-testid^="attendance-"]')).filter(node=>/^attendance-(staff|players|others)-(yes|maybe|no|noReply)-usr_\\w+$/.test(node.dataset.testid));
          return cards.length>0 && cards.every(card=>parseFloat(getComputedStyle(card).paddingLeft)===0 && parseFloat(getComputedStyle(card.firstElementChild).paddingLeft)===16 && parseFloat(getComputedStyle(card.firstElementChild).paddingTop)===16);
        })()`)
      ).to.equal(true)
      await m.evalBrowserScript({
        script: `document.querySelector('[data-testid^="attendance-players-"] [data-testid^="attendance-players-"]').scrollIntoView({block:'center'})`
      })
      await web.shot('compact-attendance.png')
      const hero = await evaluate<{
        separate: boolean
        color: string
        font: number
      }>(`(()=>{
        const date=document.querySelector('[data-testid="event-hero-date"]'), time=document.querySelector('[data-testid="event-hero-time"]');
        return {separate:date.getBoundingClientRect().bottom<=time.getBoundingClientRect().top,color:getComputedStyle(date).color,font:parseFloat(getComputedStyle(date).fontSize)};
      })()`)
      expect(
        hero.separate && hero.color === 'rgb(0, 0, 0)' && hero.font === 13.75,
        `Hero date and time are two larger black lines: ${JSON.stringify(hero)}`
      ).to.equal(true)
      await web.shot('hero-two-lines.png')
      expect(
        await evaluate<boolean>(
          `!document.querySelector('[data-testid="event-attendance-teams"]').textContent.includes('RSVPs') && !document.body.textContent.includes('No one yet')`
        )
      ).to.equal(true)
      const spacing = await evaluate<number>(
        `(()=>{const card=document.querySelector('[data-testid="event-replies"]'),header=card.previousElementSibling;return card.getBoundingClientRect().top-header.getBoundingClientRect().bottom})()`
      )
      expect(spacing).to.be.within(0, 8)
      await m.evalBrowserScript({
        script: `document.querySelector('[data-testid="event-replies"]').scrollIntoView({block:'center'})`
      })
      await new Promise(resolve => setTimeout(resolve, 400))
      await web.shot('event-replies.png')
      await m.evalBrowserScript({
        script: `document.querySelector('[aria-label="RSVP teams"]').scrollIntoView({block:'center'})`
      })
      const points = await evaluate<Array<{ x: number; y: number }>>(
        `Array.from(document.querySelector('[aria-label="RSVP teams"]').querySelectorAll('[role="tab"]')).map(node=>{const r=node.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})`
      )
      const drag = async (from: number, to: number): Promise<void> => {
        await m.dragAndDrop({
          from: { point: at(points[from].x, points[from].y) },
          to: { point: at(points[to].x, points[to].y) },
          holdDuration: 100,
          duration: 800
        })
      }
      const teamSelected = (index: number): string =>
        `document.querySelectorAll('[aria-label="RSVP teams"] [role="tab"]')[${index}]?.getAttribute('aria-selected')==='true'`
      await drag(0, 1)
      await wait(teamSelected(1))
      await drag(1, 0)
      await wait(teamSelected(0))
      // A finger that strays well below the rail keeps the drag, and the
      // pill goes on from where it was let go.
      await m.evalBrowserScript({
        script: `window.__pillTrace=[];(function tick(){const fill=document.querySelector('[aria-label="RSVP teams"] [data-testid="segmented-pill-fill"]');window.__pillTrace.push(new DOMMatrix(getComputedStyle(fill).transform).m41);if(window.__pillTrace.length<3000)requestAnimationFrame(tick)})()`
      })
      await m.dragAndDrop({
        from: { point: at(points[0].x, points[0].y) },
        to: { point: at(points[1].x, points[1].y + 120) },
        holdDuration: 100,
        duration: 800
      })
      await wait(teamSelected(1))
      await new Promise(resolve => setTimeout(resolve, 600))
      const trace = await evaluate<{ half: number; values: number[] }>(
        `({half:document.querySelector('[aria-label="RSVP teams"]').getBoundingClientRect().width/2,values:window.__pillTrace})`
      )
      const moved = trace.values.findIndex(value => value > trace.half / 4)
      expect(moved, 'The team pill follows the finger').to.be.at.least(0)
      expect(
        trace.values.slice(moved).every(value => value > trace.half / 8),
        'The team pill never jumps back after it is let go'
      ).to.equal(true)
      expect(
        Math.abs(trace.values[trace.values.length - 1] - trace.half)
      ).to.be.below(2)
      await drag(1, 0)
      await wait(teamSelected(0))
      // "Are you going?" is a card of compact lines: avatar, a bold name the
      // size of the pill text, and the reply in its capsule colour.
      expect(
        await evaluate<boolean>(`(()=>{
          const replies=document.querySelector('[data-testid="event-replies"]'), colours=['rgb(32, 138, 75)','rgb(35, 118, 207)','rgb(203, 57, 65)'];
          const rows=Array.from(replies.querySelectorAll('[data-testid^="event-reply-row-"]'));
          return getComputedStyle(replies).backgroundColor!=='rgba(0, 0, 0, 0)' && replies.querySelector('[role="radiogroup"]')==null && rows.length>0 && rows.every(row=>{
            const id=row.getAttribute('data-testid').slice(16), status=row.querySelector('[data-testid="event-reply-status-'+id+'"]'), name=row.querySelector('[data-testid="event-reply-name-'+id+'"]');
            return row.getBoundingClientRect().height<=40 && Math.abs(status.getBoundingClientRect().right-row.getBoundingClientRect().right)<1 &&
              colours.includes(getComputedStyle(status).color) && ['Yes','Maybe','No','No reply'].includes(status.textContent) &&
              getComputedStyle(name).fontSize==='14px' && Number(getComputedStyle(name).fontWeight)>=600;
          });
        })()`)
      ).to.equal(true)
      // A tap anywhere in it opens the RSVP modal.
      const replyIds = await evaluate<string[]>(
        `Array.from(document.querySelectorAll('[data-testid^="event-reply-row-"]')).map(row=>row.getAttribute('data-testid').slice(16))`
      )
      await tap(web, `event-reply-row-${replyIds[replyIds.length - 1]}`)
      await wait(
        `document.querySelector('[data-testid="event-rsvp-modal"] [role="radiogroup"]')!=null`
      )
      // In it, an RSVP capsule keeps a finger that strays below it: Yes to No.
      const rsvpId = await evaluate<string>(
        `document.querySelector('[data-testid="event-rsvp-modal"] [role="radiogroup"]').getAttribute('data-testid')`
      )
      await tap(web, `${rsvpId}-0`)
      await wait(
        `document.querySelector('[data-testid="${rsvpId}-0"]').getAttribute('aria-checked')==='true'`
      )
      const rsvp = await evaluate<{
        yes: { x: number; y: number }
        no: { x: number; y: number }
      }>(
        `(()=>{const radios=document.querySelectorAll('[data-testid="${rsvpId}"] [role="radio"]'),at=n=>{const r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}};return{yes:at(radios[0]),no:at(radios[2])}})()`
      )
      await m.dragAndDrop({
        from: { point: at(rsvp.yes.x, rsvp.yes.y) },
        to: { point: at(rsvp.no.x, rsvp.no.y + 120) },
        holdDuration: 100,
        duration: 800
      })
      await wait(
        `document.querySelector('[data-testid="${rsvpId}-2"]').getAttribute('aria-checked')==='true'`
      )
      // No reply has room for one line in the label's own font, and both
      // slider rails are dark enough to show on the page.
      expect(
        await evaluate<boolean>(`(()=>{
          const modal=document.querySelector('[data-testid="event-rsvp-modal"]'), canvas=document.createElement('canvas').getContext('2d'), rail='rgb(205, 213, 194)';
          const pills=Array.from(modal.querySelectorAll('[role="radiogroup"]')), teams=document.querySelector('[aria-label="RSVP teams"]');
          return pills.every(pill=>{
            const middle=pill.querySelectorAll('[role="radio"]')[1], label=middle.querySelector('[dir="auto"]'), style=getComputedStyle(middle);
            canvas.font=getComputedStyle(label).font;
            const room=middle.getBoundingClientRect().width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
            return canvas.measureText('No reply').width*1.1<=room && getComputedStyle(pill.firstElementChild).backgroundColor===rail;
          }) && getComputedStyle(teams).backgroundColor===rail && getComputedStyle(document.body).backgroundColor!==rail;
        })()`)
      ).to.equal(true)
      await web.shot('rsvp-modal.png')
      await m.tapOn({ text: 'Done' })
      await dismissNotificationAsk(m)
      await wait(
        `document.querySelector('[data-testid="event-rsvp-modal"]')==null && document.querySelector('[data-testid="event-reply-status-${rsvpId.slice(11)}"]')?.textContent==='No'`
      )
      await web.shot('info-after.png')
    },

    // On the general schedule, a date column with no RSVP line sits centred
    // on the details, its weekday smaller in proportion.
    'display-schedule': async ctx => {
      const w = await ctx.fixture('event-schedule')
      const web = await openEventWeb(ctx, w.accounts.owner, PHONE)
      await web.go('/schedule?when=all')
      await web.wait(
        `document.querySelector('[data-testid="schedule-display-row"]')!=null`
      )
      await web.wait(`Array.from(document.querySelectorAll('[data-testid="schedule-display-row"]')).every(row=>{
        const date=row.querySelector('[data-testid="schedule-date"]').getBoundingClientRect(), details=row.querySelector('[data-testid="schedule-details"]').getBoundingClientRect();
        return Math.abs((date.top+date.bottom)/2-(details.top+details.bottom)/2)<1;
      })`)
      expect(
        await web.evaluate<boolean>(`Array.from(document.querySelectorAll('[data-testid="schedule-display-row"]')).every(row=>{
          const date=row.querySelector('[data-testid="schedule-date"]'), weekday=date.querySelector('[data-testid="schedule-weekday"]'), day=date.lastElementChild, month=day.previousElementSibling;
          const ratio=parseFloat(getComputedStyle(day).fontSize)/parseFloat(getComputedStyle(weekday).fontSize);
          // The weekday is a quarter smaller than the month.
          return Math.abs(ratio-32/15)<.01 && Math.abs(parseFloat(getComputedStyle(weekday).fontSize)/parseFloat(getComputedStyle(month).fontSize)-.75)<.01 && row.querySelector('[data-testid^="schedule-rsvps-"]')==null;
        })`)
      ).to.equal(true)
      await web.shot('display-schedule.png')
    },

    // The event map in Google's own Maps JavaScript SDK, dragged. The old
    // module ran this only given a Maps key file.
    'google-map': async () => {
      throw new BlockedError(
        "needs a stack whose serverConfig.googleMaps carries a Maps JavaScript API web key; the pool stack's has none, so the Info tab draws the Leaflet map"
      )
    }
  }
})
