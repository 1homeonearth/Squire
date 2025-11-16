// src/lib/poll-format.js
// Helpers for summarising Discord poll messages in text form.

function formatAnswerLine(answer, { totalVotes }) {
    if (!answer) return null;
    const parts = [];
    const emoji = answer.emoji?.toString?.();
    if (emoji) {
        parts.push(emoji.trim());
    }
    const label = answer.text?.trim?.();
    if (label) {
        parts.push(label);
    }
    const baseLabel = parts.length ? parts.join(' ') : `Option ${answer.id}`;

    const votes = typeof answer.voteCount === 'number'
        ? answer.voteCount
        : (typeof answer.voters?.cache?.size === 'number' ? answer.voters.cache.size : null);

    let suffix;
    if (typeof votes === 'number') {
        const percent = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : null;
        const voteWord = votes === 1 ? 'vote' : 'votes';
        if (percent !== null) {
            suffix = `${votes} ${voteWord} (${percent}%)`;
        } else {
            suffix = `${votes} ${voteWord}`;
        }
    } else {
        suffix = 'votes hidden';
    }

    return `• ${baseLabel} — ${suffix}`;
}

export function formatPollLines(poll) {
    if (!poll) return [];

    const lines = [];
    const question = poll.question?.text?.trim?.();
    if (question) {
        lines.push(`📊 **${question}**`);
    } else {
        lines.push('📊 **Poll**');
    }

    const answers = Array.from(poll.answers?.values?.() ?? []);
    const totalVotes = answers.reduce((sum, answer) => {
        const votes = typeof answer.voteCount === 'number'
            ? answer.voteCount
            : (typeof answer.voters?.cache?.size === 'number' ? answer.voters.cache.size : 0);
        return sum + (Number.isFinite(votes) ? votes : 0);
    }, 0);

    for (const answer of answers) {
        const line = formatAnswerLine(answer, { totalVotes });
        if (line) {
            lines.push(line);
        }
    }

    if (poll.allowMultiselect === true) {
        lines.push('Allows multiple selections.');
    }

    if (poll.expiresTimestamp) {
        const unix = Math.floor(poll.expiresTimestamp / 1000);
        if (Number.isFinite(unix)) {
            lines.push(`Ends <t:${unix}:R>.`);
        }
    }

    return lines;
}
