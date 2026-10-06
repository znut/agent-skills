#!/usr/bin/perl
# dismiss-ask.pl <asks-file> <text>: drop the asks whose line, trimmed, is exactly <text>.
# The asks file's own rules: its detail file <n>.md under <asks-file>.d goes with it, each later
# <m>.md moves to its new line number in ascending order, and the <asks-file>.meta sidecar (one
# line per ask) stays parallel. The asks hook's writers hold a kernel flock on <asks-file>.lock;
# this takes the same lock, and writes the new files to temps renamed into place.
use strict;
use warnings;
use Fcntl qw(:flock);

my ($asks, $text) = @ARGV;
exit 2 unless defined $text && $text ne '';
open(my $lock, '>>', "$asks.lock") or exit 1;
local $SIG{ALRM} = sub { exit 1 };
alarm 5;
flock($lock, LOCK_EX) or exit 1;
alarm 0;

open(my $in, '<', $asks) or exit 0;
my @lines = map { s/\n?\z/\n/r } <$in>;
close $in;
my $trim = sub { my $s = shift; $s =~ s/^\s+|\s+$//g; $s };
exit 0 unless grep { $trim->($_) eq $text } @lines;

my $hasMeta = open(my $min, '<', "$asks.meta");
my @meta = $hasMeta ? map { s/\n?\z/\n/r } <$min> : ();
close $min if $hasMeta;

my $detail = "$asks.d";
my (@out, @outMeta);
for my $i (1 .. @lines) {
	my $line = $lines[$i - 1];
	if ($trim->($line) eq $text) {
		unlink "$detail/$i.md";
		next;
	}
	push @out, $line;
	push @outMeta, $meta[$i - 1] // "0\n";
	my $m = @out;
	rename "$detail/$i.md", "$detail/$m.md" if $m != $i && -f "$detail/$i.md";
}

sub replace {
	my ($path, @rows) = @_;
	my $tmp = "$path.dismiss.$$";
	open(my $out, '>', $tmp) or exit 1;
	print $out @rows;
	close $out or exit 1;
	rename $tmp, $path or exit 1;
}
replace("$asks.meta", @outMeta) if $hasMeta;
replace($asks, @out);
